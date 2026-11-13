(() => {
  const $ = id => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const configured = cfg.SUPABASE_URL?.includes(".supabase.co") && !cfg.SUPABASE_URL.includes("YOUR_") &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR_");
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY) : null;
  let employee = null, role = null, timer = null, stream = null, pinRequired = false;
  const show = (id,on=true) => $(id).classList.toggle("hidden",!on);
  const msg = (id,t,ok=false) => { $(id).textContent=t; $(id).className="message"+(ok?" success":""); };
  const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const normalizeBarcode = raw => {
    const s = String(raw ?? "").replace(/[\\r\\n\\t]+$/g,"").trim();
    if (s.startsWith("[)> 06 P")) {
      const body=s.slice(8), end=body.search(/\\s/);
      return (end<0?body:body.slice(0,end)).trim();
    }
    return s;
  };
  $("employee-id").addEventListener("input",()=>{
    const id=$("employee-id").value.replace(/\\D/g,"").slice(0,6); $("employee-id").value=id;
    show("pin-wrap", id.length===6 && $("employee-id").dataset.roleRequired==="true");
  });
  $("login").onclick=async()=>{
    const id=$("employee-id").value.trim();
    if(!/^\\d{6}$/.test(id)){msg("login-message","請輸入6碼數字工號");return;}
    if(!sb){msg("login-message","尚未設定 Supabase URL／Anon Key，請先編輯 config.js");return;}
    msg("login-message","正在驗證工號…");
    // First request may return requires_pin=true for ADMIN/DEVELOPER.
    // The authoritative role/PIN decision is made only by the Edge Function.
    const pin=$("pin").value;
    try{
      const {data,error}=await sb.functions.invoke("employee-login",{body:{employee_id:id,pin:pinRequired?(pin||null):null,check_only:!pinRequired}});
      if(error) throw error;
      if(data?.requires_pin && !pinRequired){
        pinRequired=true; show("pin-wrap",true); $("pin").focus();
        msg("login-message","此工號具有管理權限，請輸入 PIN 後再次登入。");
        return;
      }
      if(!data?.access_token || !data?.refresh_token) throw new Error(data?.message||"登入服務未回傳有效 Session");
      const {error:sessionError}=await sb.auth.setSession({access_token:data.access_token,refresh_token:data.refresh_token});
      if(sessionError) throw sessionError;
      employee=data.employee_id; role=data.role; pinRequired=false; enterWorkspace();
    }catch(e){msg("login-message",e.message||"登入失敗");}
  };
  function enterWorkspace(){
    show("login-panel",false);show("workspace");show("logout");$("session-label").textContent=`工號：${employee}｜${role}`;
    show("admin-panel",role==="ADMIN"||role==="DEVELOPER");show("developer-panel",role==="DEVELOPER");
  }
  $("logout").onclick=async()=>{if(sb) await sb.auth.signOut();employee=role=null;show("workspace",false);show("login-panel");show("logout",false);$("session-label").textContent="請輸入工號登入";};
  async function search(){
    const key=normalizeBarcode($("keyword").value);
    $("keyword").value=key;
    if(!key){$("results").innerHTML='<p class="empty">請輸入件號或儲位。</p>';return;}
    if(!sb){$("results").innerHTML='<p class="empty">尚未設定 Supabase 連線資訊。</p>';return;}
    $("results").innerHTML='<p class="empty">查詢中…</p>';
    const {data,error}=await sb.rpc("search_inventory",{p_keyword:key,p_limit:200});
    if(error){$("results").innerHTML=`<p class="empty">${esc(error.message)}</p>`;return;}
    renderResults(data||[]);
  }
  function renderResults(rows){
    if(!rows.length){$("results").innerHTML='<p class="empty">查無符合資料。</p>';return;}
    const groups=new Map();
    rows.forEach(r=>{const k=r.material; if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);});
    let html="";
    for(const [material,items] of groups){
      const first=items[0];
      html+=`<article class="material-card"><div class="material-title">${esc(first.material)}</div>
      <div class="material-description">${esc(first.material_description||"")}</div>
      <div class="info-grid">
        <div class="info"><small>廠區 Plnt</small><strong>${esc(first.plnt)}</strong></div>
        <div class="info"><small>物料群</small><strong>${esc(first.matl_group)}</strong></div>
        <div class="info"><small>車型 MRPCn</small><strong>${esc(first.mrpcn)}</strong></div>
      </div><div class="table-wrap"><table><thead><tr><th>儲區</th><th>儲位</th><th>盤點量</th><th>盤點人</th></tr></thead><tbody>`;
      for(const r of items) html+=`<tr><td>${esc(r.location)}</td><td><strong>${esc(r.bin_number||"（空白）")}</strong></td><td class="qty">${esc(r.quantity)}</td><td>${esc(r.counter_name)}</td></tr>`;
      html+="</tbody></table></div></article>";
    }
    $("results").innerHTML=html;
  }
  $("search").onclick=search;
  $("keyword").addEventListener("keydown",e=>{if(e.key==="Enter")search();});
  $("keyword").addEventListener("input",()=>{
    clearTimeout(timer);const key=$("keyword").value.trim();
    if(!key||!sb){show("suggestions",false);return;}
    timer=setTimeout(async()=>{
      const {data}=await sb.rpc("search_inventory",{p_keyword:key,p_limit:8});
      const list=(data||[]).slice(0,8);
      $("suggestions").innerHTML=list.map(r=>`<div class="suggestion" data-value="${esc(r.material)}">${esc(r.material)}｜${esc(r.material_description||"")}｜${esc(r.bin_number)}</div>`).join("");
      show("suggestions",list.length>0);
      $("suggestions").querySelectorAll(".suggestion").forEach(el=>el.onclick=()=>{$("keyword").value=el.dataset.value;show("suggestions",false);search();});
    },250);
  });
  $("scan").onclick=async()=>{
    if(!navigator.mediaDevices?.getUserMedia){msg("login-message","此瀏覽器不支援相機掃描，請使用外接掃描器或手動輸入");return;}
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
      $("camera").srcObject=stream;await $("camera").play();show("camera");show("stop-camera");
      msg("login-message","相機已啟動。此版本先提供相機預覽；條碼解碼器將於掃描模組階段加入。");
    }catch(e){alert("無法啟動相機："+e.message);}
  };
  $("stop-camera").onclick=()=>{stream?.getTracks().forEach(t=>t.stop());stream=null;show("camera",false);show("stop-camera",false);};
  // Keyboard-wedge barcode scanners type into the focused search field.
  $("upload").onclick=async()=>{
    const file=$("txt-file").files[0];if(!file){$("upload-result").textContent="請先選擇 TXT 檔案。";return;}
    if(!sb){$("upload-result").textContent="尚未設定 Supabase。";return;}
    try{
      const buffer=await file.arrayBuffer();
      const bytes=new Uint8Array(buffer);
      const text=new TextDecoder("big5").decode(bytes);
      const lines=text.replace(/^\\uFEFF/,"").split(/\\r?\\n/).filter(x=>x.length);
      const headers=lines.shift().split("\\t").map(x=>x.trim());
      const expected=["Plnt","Location","Year","Pl.CntDte","Bin","Bin Number","Item","Material","Quantity"];
      if(expected.some((h,i)=>headers[i]!==h)){throw new Error("TXT 標題欄位與規格不符。實際："+headers.join(" / "));}
      const rows=lines.map(line=>{
        const c=line.split("\\t");
        return {plnt:c[0]||"",location:c[1]||"",year:c[2]||"",pl_cnt_dte:c[3]||"",bin:c[4]||"",bin_number:c[5]||"",item:c[6]||"",material:c[7]||"",quantity:c[8]||""};
      });
      const {data,error}=await sb.rpc("apply_inventory_txt_upload",{p_file_name:file.name,p_rows:rows});
      if(error)throw error;
      $("upload-result").textContent=JSON.stringify(data,null,2);
    }catch(e){$("upload-result").textContent="上傳失敗："+e.message;}
  };
  $("db-test").onclick=async()=>{
    const {data,error}=await sb.rpc("test_database_connection");
    $("db-result").textContent=error?error.message:JSON.stringify(data,null,2);
  };
  // Show PIN input for roles configured as privileged after safe employee lookup.
  // Edge Function, not browser JS, makes the authoritative role decision.
  $("employee-id").addEventListener("blur",()=>{ /* role lookup intentionally server-side */ });
})();