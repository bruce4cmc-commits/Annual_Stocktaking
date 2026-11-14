(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const configured =
    typeof cfg.SUPABASE_URL === "string" &&
    cfg.SUPABASE_URL.includes(".supabase.co") &&
    !cfg.SUPABASE_URL.includes("YOUR_") &&
    typeof cfg.SUPABASE_ANON_KEY === "string" &&
    cfg.SUPABASE_ANON_KEY.length > 0 &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR_");

  const sb = configured && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  let employee = null;
  let role = null;
  let timer = null;
  let stream = null;
  let pinRequired = false;

  const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
  const msg = (id, text, ok = false) => {
    $(id).textContent = text;
    $(id).className = "message" + (ok ? " success" : "");
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  // Barcode format: [)> 06 P + material code + whitespace/terminator.
  const normalizeBarcode = raw => {
    const value = String(raw ?? "").replace(/[\r\n\t]+$/g, "").trim();
    if (value.startsWith("[)> 06 P")) {
      const body = value.slice(8);
      const end = body.search(/\s/);
      return (end < 0 ? body : body.slice(0, end)).trim();
    }
    return value;
  };

  async function ensureAnonymousSession() {
    if (!sb) throw new Error("尚未設定 Supabase URL／Anon Key，請先檢查 config.js。");

    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    if (data.session) return;

    const { error: signInError } = await sb.auth.signInAnonymously();
    if (signInError) {
      throw new Error(
        "無法建立匿名登入工作階段。請確認 Supabase Anonymous Sign-Ins 已啟用。 " +
        signInError.message
      );
    }
  }

  $("employee-id").addEventListener("input", () => {
    const id = $("employee-id").value.replace(/\D/g, "").slice(0, 6);
    $("employee-id").value = id;

    if (id.length !== 6) {
      pinRequired = false;
      $("pin").value = "";
      show("pin-wrap", false);
    } else if (pinRequired) {
      show("pin-wrap", true);
    }
  });

  $("login").onclick = async () => {
    const id = $("employee-id").value.trim();
    const pin = $("pin").value.trim();

    if (!/^\d{6}$/.test(id)) {
      msg("login-message", "請輸入 6 碼數字工號。");
      return;
    }
    if (pinRequired && !/^\d{6}$/.test(pin)) {
      msg("login-message", "請輸入 6 位數 PIN。");
      return;
    }
    if (!sb) {
      msg("login-message", "尚未設定 Supabase URL／Anon Key，請先檢查 config.js。");
      return;
    }

    $("login").disabled = true;
    msg("login-message", "正在建立登入工作階段…");

    try {
      await ensureAnonymousSession();

      msg("login-message", "正在驗證員工資料…");
      const { data, error } = await sb.functions.invoke("employee-login", {
        body: {
          action: "login",
          employee_id: id,
          pin: pinRequired ? pin : null
        }
      });

      // Privileged accounts first return requires_pin=true (HTTP 200).
      if (data?.requires_pin === true && !pinRequired) {
        pinRequired = true;
        show("pin-wrap", true);
        $("pin").focus();
        msg("login-message", "此工號具有管理權限，請輸入 PIN 後再次登入。");
        return;
      }

      if (data?.code === "PIN_NOT_INITIALIZED") {
        throw new Error("此管理者尚未完成 PIN 初始化，請聯絡 DEVELOPER。");
      }
      if (data?.code === "PIN_INVALID") {
        throw new Error("PIN 錯誤，請重新輸入。");
      }
      if (data?.code === "PIN_LOCKED") {
        throw new Error("PIN 輸入錯誤次數過多，帳號已暫時鎖定。");
      }
      if (data?.code === "BIND_COOLDOWN") {
        throw new Error("此帳號目前處於 24 小時綁定冷卻期間，請使用原本登入的瀏覽器工作階段。");
      }
      if (error) {
        throw new Error(data?.message || data?.code || error.message || "登入服務呼叫失敗。");
      }
      if (!data?.success || !data?.employee_id || !data?.role) {
        throw new Error(data?.message || data?.code || "登入驗證未成功。");
      }

      employee = data.employee_id;
      role = data.role;
      pinRequired = false;
      $("pin").value = "";
      msg("login-message", "登入成功。", true);
      enterWorkspace();
    } catch (e) {
      msg("login-message", e?.message || "登入失敗，請稍後再試。");
    } finally {
      $("login").disabled = false;
    }
  };

  // Main feature tabs: each business function is displayed independently.
  function activateTab(viewId) {
    const allowed = {
      "search-view": true,
      "upload-view": role === "ADMIN" || role === "DEVELOPER",
      "people-view": role === "DEVELOPER",
      "master-upload-view": role === "DEVELOPER"
    };
    if (!allowed[viewId]) viewId = "search-view";
    document.querySelectorAll(".tab-view").forEach(view => {
      view.classList.toggle("hidden", view.id !== viewId);
    });
    document.querySelectorAll(".tab-button").forEach(button => {
      const active = button.dataset.tab === viewId;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (viewId === "people-view" && role === "DEVELOPER" && employeeRows.length === 0) {
      loadEmployees();
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  function enterWorkspace() {
    show("login-panel", false);
    show("workspace");
    show("logout");
    $("session-label").textContent = `工號：${employee}｜${role}`;
    show("admin-panel", role === "ADMIN" || role === "DEVELOPER");
    show("developer-panel", role === "DEVELOPER");
    show("main-tabs");
    show("upload-tab", role === "ADMIN" || role === "DEVELOPER");
    show("people-tab", role === "DEVELOPER");
    show("master-upload-tab", role === "DEVELOPER");
    show("master-upload-panel", role === "DEVELOPER");
    activateTab("search-view");
    if (role === "DEVELOPER") loadEmployees();
  }

  $("logout").onclick = () => {
    // Intentionally retain the Anonymous Auth session.
    // Signing out would create a new Auth UUID on the next login and can
    // trigger the database's 24-hour employee binding cooldown.
    employee = null;
    role = null;
    pinRequired = false;
    $("employee-id").value = "";
    $("pin").value = "";
    show("pin-wrap", false);
    show("workspace", false);
    show("main-tabs", false);
    show("login-panel");
    show("logout", false);
    $("session-label").textContent = "請輸入工號登入";
    msg("login-message", "已登出。此瀏覽器的安全工作階段已保留，以維持帳號綁定。", true);
  };

  async function search() {
    const key = normalizeBarcode($("keyword").value);
    $("keyword").value = key;

    if (!key) {
      $("results").innerHTML = '<p class="empty">請輸入件號或儲位。</p>';
      return;
    }
    if (!sb) {
      $("results").innerHTML = '<p class="empty">尚未設定 Supabase 連線資訊。</p>';
      return;
    }

    $("results").innerHTML = '<p class="empty">查詢中…</p>';
    const { data, error } = await sb.rpc("search_inventory", {
      p_keyword: key,
      p_limit: 200
    });
    if (error) {
      $("results").innerHTML = `<p class="empty">${esc(error.message)}</p>`;
      return;
    }
    renderResults(data || []);
  }

  function renderResults(rows) {
    if (!rows.length) {
      $("results").innerHTML = '<p class="empty">查無符合資料。</p>';
      return;
    }

    const groups = new Map();
    rows.forEach(row => {
      const key = row.material;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });

    let html = "";
    for (const [material, items] of groups) {
      const first = items[0];
      html += `<article class="material-card">
        <div class="material-title">${esc(first.material)}</div>
        <div class="material-description">${esc(first.material_description || "")}</div>
        <div class="info-grid">
          <div class="info"><small>廠區</small><strong>${esc(first.plnt)}</strong></div>
          <div class="info"><small>物料群</small><strong>${esc(first.matl_group)}</strong></div>
          <div class="info"><small>車型</small><strong>${esc(first.mrpcn)}</strong></div>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>儲區</th><th>儲位</th><th>盤點量</th><th>盤點人</th>
        </tr></thead><tbody>`;
      for (const row of items) {
        html += `<tr>
          <td>${esc(row.location)}</td>
          <td><strong>${esc(row.bin_number || "（空白）")}</strong></td>
          <td class="qty">${esc(row.quantity)}</td>
          <td>${esc(row.counter_name)}</td>
        </tr>`;
      }
      html += "</tbody></table></div></article>";
    }
    $("results").innerHTML = html;
  }

  $("search").onclick = search;
  $("keyword").addEventListener("keydown", event => {
    if (event.key === "Enter") search();
  });
  $("keyword").addEventListener("input", () => {
    clearTimeout(timer);
    const key = $("keyword").value.trim();
    if (!key || !sb) {
      show("suggestions", false);
      return;
    }

    timer = setTimeout(async () => {
      const { data, error } = await sb.rpc("search_inventory", {
        p_keyword: key,
        p_limit: 8
      });
      if (error) {
        show("suggestions", false);
        return;
      }
      const list = (data || []).slice(0, 8);
      $("suggestions").innerHTML = list.map(row =>
        `<div class="suggestion" data-value="${esc(row.material)}">
          ${esc(row.material)}｜${esc(row.material_description || "")}｜${esc(row.bin_number)}
        </div>`
      ).join("");
      show("suggestions", list.length > 0);
      $("suggestions").querySelectorAll(".suggestion").forEach(element => {
        element.onclick = () => {
          $("keyword").value = element.dataset.value;
          show("suggestions", false);
          search();
        };
      });
    }, 250);
  });

  $("scan").onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      msg("login-message", "此瀏覽器不支援相機掃描，請使用外接掃描器或手動輸入。");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
      $("camera").srcObject = stream;
      await $("camera").play();
      show("camera");
      show("stop-camera");
      msg("login-message", "相機已啟動。此版本先提供相機預覽；條碼解碼器將於掃描模組階段加入。");
    } catch (e) {
      alert("無法啟動相機：" + e.message);
    }
  };

  $("stop-camera").onclick = () => {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    show("camera", false);
    show("stop-camera", false);
  };

  $("upload").onclick = async () => {
    const file = $("txt-file").files[0];
    if (!file) {
      $("upload-result").textContent = "請先選擇 TXT 檔案。";
      return;
    }
    if (!sb) {
      $("upload-result").textContent = "尚未設定 Supabase。";
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = new TextDecoder("big5").decode(bytes);
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.length);
      if (!lines.length) throw new Error("TXT 檔案沒有內容。");

      const headers = lines.shift().split("\t").map(value => value.trim());
      const expected = [
        "Plnt", "Location", "Year", "Pl.CntDte", "Bin",
        "Bin Number", "Item", "Material", "Quantity"
      ];
      if (expected.some((header, index) => headers[index] !== header)) {
        throw new Error("TXT 標題欄位與規格不符。實際：" + headers.join(" / "));
      }

      const rows = lines.map(line => {
        const columns = line.split("\t");
        return {
          plnt: columns[0] || "",
          location: columns[1] || "",
          year: columns[2] || "",
          pl_cnt_dte: columns[3] || "",
          bin: columns[4] || "",
          bin_number: columns[5] || "",
          item: columns[6] || "",
          material: columns[7] || "",
          quantity: columns[8] || ""
        };
      });

      const { data, error } = await sb.rpc("apply_inventory_txt_upload", {
        p_file_name: file.name,
        p_rows: rows
      });
      if (error) throw error;
      $("upload-result").textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      $("upload-result").textContent = "上傳失敗：" + e.message;
    }
  };

  // V1.1 employee administration. All mutations are server-authorized.
  let employeeRows = [];
  let editingEmployeeId = null;
  async function employeeAction(action, payload = {}) {
    await ensureAnonymousSession();
    const { data, error } = await sb.functions.invoke("employee-login", { body: { action, ...payload } });
    if (error || !data?.success) throw new Error(data?.code || data?.message || error?.message || "管理操作失敗");
    return data;
  }
  function employeeMessage(text, ok=false) { msg("employee-message", text, ok); }
  function renderEmployees() {
    const filter = $("employee-filter").value.trim().toLowerCase();
    const rows = employeeRows.filter(x => `${x.employee_id} ${x.employee_name}`.toLowerCase().includes(filter));
    if (!rows.length) { $("employee-rows").innerHTML = '<tr><td colspan="5">沒有符合的人員資料</td></tr>'; return; }
    $("employee-rows").innerHTML = rows.map(x => `<tr>
      <td><strong>${esc(x.employee_id)}</strong><br>${esc(x.employee_name)}</td>
      <td>${esc(x.role)}</td><td class="${x.is_active?'status-active':'status-inactive'}">${x.is_active?'啟用':'停用'}</td>
      <td class="pin-state">${['ADMIN','DEVELOPER'].includes(x.role) ? (x.pin_configured?'已設定':'未設定') : '不適用'}${x.locked_until && new Date(x.locked_until)>new Date()?'<br>鎖定中':''}</td>
      <td class="actions"><button class="secondary" data-edit="${esc(x.employee_id)}">編輯</button>
      ${['ADMIN','DEVELOPER'].includes(x.role)?`<button class="secondary" data-pin="${esc(x.employee_id)}" data-mode="${x.pin_configured?'reset':'init'}">${x.pin_configured?'重設 PIN':'初始化 PIN'}</button>`:''}
      <button class="${x.is_active?'quiet':'secondary'}" data-active="${esc(x.employee_id)}" data-value="${!x.is_active}">${x.is_active?'停用':'啟用'}</button></td></tr>`).join("");
    $("employee-rows").querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>editEmployee(b.dataset.edit));
    $("employee-rows").querySelectorAll("[data-active]").forEach(b=>b.onclick=()=>toggleEmployee(b.dataset.active,b.dataset.value==="true"));
    $("employee-rows").querySelectorAll("[data-pin]").forEach(b=>b.onclick=()=>managePin(b.dataset.pin,b.dataset.mode));
  }
  async function loadEmployees() {
    try { employeeMessage("正在讀取人員清單…"); const d=await employeeAction("list_employees"); employeeRows=d.employees||[]; renderEmployees(); employeeMessage(`已載入 ${employeeRows.length} 筆人員資料。`,true); }
    catch(e){ employeeMessage(e.message); }
  }
  function resetEmployeeForm() { editingEmployeeId=null; $("new-employee-id").disabled=false; $("new-employee-id").value=""; $("new-employee-name").value=""; $("new-employee-role").value="USER"; $("employee-form-title").textContent="新增人員"; $("employee-save").textContent="新增人員"; show("employee-cancel",false); }
  function editEmployee(id) { const x=employeeRows.find(r=>r.employee_id===id); if(!x)return; editingEmployeeId=id; $("new-employee-id").value=id; $("new-employee-id").disabled=true; $("new-employee-name").value=x.employee_name; $("new-employee-role").value=x.role; $("employee-form-title").textContent=`修改人員 ${id}`; $("employee-save").textContent="儲存修改"; show("employee-cancel",true); $("new-employee-name").scrollIntoView({behavior:"smooth",block:"center"}); }
  async function toggleEmployee(id,active) { if(!confirm(`${active?'確定啟用':'確定停用'}工號 ${id}？`))return; try{await employeeAction("set_employee_active",{employee_id:id,is_active:active});employeeMessage("人員狀態已更新。",true);await loadEmployees();}catch(e){employeeMessage(e.message);} }
  async function managePin(id,mode) { const pin=prompt(`請輸入工號 ${id} 的新 6 位數 PIN：`); if(pin===null)return; if(!/^\d{6}$/.test(pin)){employeeMessage("PIN 必須為 6 位數字。");return;} const confirmPin=prompt("請再次輸入新 PIN："); if(confirmPin!==pin){employeeMessage("兩次 PIN 不一致。");return;} try{await employeeAction(mode==="reset"?"reset_employee_pin":"initialize_employee_pin",{employee_id:id,pin});employeeMessage(mode==="reset"?"PIN 重設成功。":"PIN 初始化成功。",true);await loadEmployees();}catch(e){employeeMessage(e.message);} }
  $("employee-refresh").onclick=loadEmployees;
  $("employee-filter").addEventListener("input",renderEmployees);
  $("employee-cancel").onclick=resetEmployeeForm;
  $("employee-save").onclick=async()=>{const id=$("new-employee-id").value.trim(),name=$("new-employee-name").value.trim(),targetRole=$("new-employee-role").value;if(!/^\d{6}$/.test(id)||name.length<2||name.length>4){employeeMessage("請輸入 6 位數工號及 2～4 字姓名。");return;}try{if(editingEmployeeId){await employeeAction("update_employee",{employee_id:id,employee_name:name,role:targetRole});employeeMessage("人員資料已更新。",true);}else{await employeeAction("create_employee",{employee_id:id,employee_name:name,role:targetRole});employeeMessage("人員新增成功。",true);}resetEmployeeForm();await loadEmployees();}catch(e){employeeMessage(e.message);}};


  // V1.3: Developer-only inventory master replacement. Validate XLSX locally first.
  let validatedMasterRows = null;
  const masterHeaders = ["Plnt","Location","Year","Pl.CntDte","原始盤點單","盤點單項目","Bin","Bin Number","Item","Material","ZC","Quantity","Material Description","Matl Group","MRPCn","盤點人"];
  function excelDateToISO(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0,10);
    if (typeof value === "number") { const d = XLSX.SSF.parse_date_code(value); if(!d) return null; return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`; }
    const t=String(value).trim(); if(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t)){const a=t.split(/[-/]/);return `${a[0]}-${a[1].padStart(2,"0")}-${a[2].padStart(2,"0")}`;} return null;
  }
  function validateMasterRow(r, index) {
    const [plnt,location,year,date,original,countItem,bin,binNumber,item,material,zc,quantity,description,group,mrpcn,counter]=r;
    const n=Number(quantity);
    if (plnt==null || location==null || !String(material??"").trim()) throw new Error(`第 ${index+2} 列：廠區、儲區及 Material 不可空白。`);
    if (!Number.isInteger(Number(year)) || Number(year)<2000 || Number(year)>2100) throw new Error(`第 ${index+2} 列：Year 格式錯誤。`);
    if (!Number.isFinite(n)) throw new Error(`第 ${index+2} 列：Quantity 必須為數字。`);
    if (!Number.isInteger(Number(item))) throw new Error(`第 ${index+2} 列：Item 必須為整數。`);
    const iso=excelDateToISO(date); if(date && !iso) throw new Error(`第 ${index+2} 列：Pl.CntDte 日期格式錯誤。`);
    return {plnt:String(plnt),location:String(location),year:Number(year),pl_cnt_dte:iso,original_count_sheet:String(original??""),count_sheet_item:String(countItem??""),bin:String(bin??""),bin_number:String(binNumber??""),item:Number(item),material:String(material).trim(),zc:String(zc??""),quantity:n,material_description:String(description??""),matl_group:String(group??""),mrpcn:String(mrpcn??""),counter_name:String(counter??"")};
  }
  $("master-validate").onclick = async () => {
    validatedMasterRows=null; $("master-replace").disabled=true; show("master-replace",false);
    const file=$("master-file").files[0];
    if(role!=="DEVELOPER"){ $("master-preview").textContent="權限不足：僅 DEVELOPER 可更新清冊。"; return; }
    if(!file){$("master-preview").textContent="請先選擇 Excel 清冊。";return;}
    if(!/\.xlsx?$/i.test(file.name)){ $("master-preview").textContent="格式錯誤：僅接受 .xlsx 或 .xls。"; return; }
    try {
      if(!window.XLSX) throw new Error("Excel 解析元件載入失敗，請確認網路/CDN連線。");
      const wb=XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true});
      const ws=wb.Sheets["原始清冊"] || wb.Sheets[wb.SheetNames[0]];
      if(!ws) throw new Error("檔案沒有可讀取的工作表。");
      const data=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:true});
      if(!data.length) throw new Error("清冊沒有資料。");
      const headers=data[0].map(x=>String(x??"").trim());
      if(headers.length!==masterHeaders.length || masterHeaders.some((h,i)=>headers[i]!==h)) throw new Error("欄位名稱或順序不符。必要欄位："+masterHeaders.join("、"));
      const source=data.slice(1).filter(r=>r.some(v=>String(v??"").trim()!==""));
      if(!source.length) throw new Error("清冊沒有有效資料列。");
      if(source.length>50000) throw new Error("資料筆數超過 50,000 筆上限。");
      validatedMasterRows=source.map(validateMasterRow);
      $("master-preview").textContent=`格式檢查通過\n檔案：${file.name}\n工作表：${ws===wb.Sheets["原始清冊"]?"原始清冊":wb.SheetNames[0]}\n有效資料：${validatedMasterRows.length} 筆\n欄位：${masterHeaders.length} 欄\n\n請確認資料筆數無誤，再按「確認覆蓋舊清冊」。`;
      show("master-replace",true); $("master-replace").disabled=false;
    } catch(e){ $("master-preview").textContent="格式檢查未通過\n"+e.message; }
  };
  $("master-replace").onclick = async () => {
    if(role!=="DEVELOPER" || !validatedMasterRows) return;
    const file=$("master-file").files[0];
    const ok=confirm(`即將以「${file.name}」的 ${validatedMasterRows.length} 筆資料覆蓋目前整份盤點清冊。此操作不可由前端復原。確定繼續？`);
    if(!ok) return;
    const btn=$("master-replace"); btn.disabled=true; btn.textContent="正在覆蓋…";
    try {
      const {data,error}=await sb.rpc("replace_inventory_master",{p_file_name:file.name,p_rows:validatedMasterRows});
      if(error) throw error;
      $("master-preview").textContent=`清冊覆蓋成功\n${JSON.stringify(data,null,2)}`;
      validatedMasterRows=null; $("master-file").value=""; show("master-replace",false);
    } catch(e){ $("master-preview").textContent="覆蓋失敗，資料庫交易已回報錯誤。請確認舊清冊仍完整。\n"+e.message; }
    finally {btn.disabled=false;btn.textContent="確認覆蓋舊清冊";}
  };

  $("db-test").onclick = async () => {
    if (!sb) {
      $("db-result").textContent = "尚未設定 Supabase。";
      return;
    }
    const { data, error } = await sb.rpc("test_database_connection");
    $("db-result").textContent = error ? error.message : JSON.stringify(data, null, 2);
  };

  $("employee-id").addEventListener("blur", () => {
    // Employee role is determined only by the Edge Function, never by browser input.
  });
})();
