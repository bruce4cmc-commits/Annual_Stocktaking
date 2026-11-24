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

  // Barcode rules:
  // - Linear barcode: use the decoded text as the material code.
  // - QR label: [)> 06 followed by an ASCII GS/RS separator and P{PART No.}.
  //   ZXing returns control separators (e.g. GS, RS) rather than ordinary spaces.
  //   Never send the full structured QR payload to inventory search.
  const normalizeBarcode = raw => {
    const value = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, ch =>
      /[\u001c-\u001f]/.test(ch) ? " " : ch
    ).trim();

    // Recognize the structured logistics QR payload, including hidden ASCII separators.
    if (/^\[\)>/.test(value)) {
      const fields = value.replace(/[\u001c-\u001f]/g, " ").split(/[\s;]+/).filter(Boolean);
      const markerIndex = fields.findIndex(field => /^P$/i.test(field));
      if (markerIndex >= 0 && fields[markerIndex + 1]) {
        return fields[markerIndex + 1].trim();
      }
      const partField = fields.find(field => /^P[A-Z0-9][A-Z0-9._/-]*$/i.test(field));
      if (partField) return partField.slice(1).trim();
      return "";
    }

    // A linear barcode is already the material code.
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
        throw new Error("裝置綁定未成功，請重新登入；若持續發生請聯絡 DEVELOPER。");
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
      "master-upload-view": role === "DEVELOPER",
      "result-view": true
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
    if (viewId === "result-view") {
      loadResultQueryState();
      loadResultUploadStatus();
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
    show("result-upload-panel", role === "DEVELOPER");
    show("result-settings-panel", role === "DEVELOPER");
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

  let barcodeReader = null;
  let barcodeControls = null;
  let scanLocked = false;

  async function stopBarcodeScan() {
    try { barcodeControls?.stop(); } catch (_) {}
    barcodeControls = null;
    try { barcodeReader?.reset(); } catch (_) {}
    barcodeReader = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    if ($("camera")) {
      try { $("camera").pause(); } catch (_) {}
      $("camera").srcObject = null;
    }
    show("camera", false);
    show("stop-camera", false);
    scanLocked = false;
  }

  const scannerMsg = (text, ok = false) => msg("scanner-message", text, ok);

  $("scan").onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      scannerMsg("此瀏覽器無法使用相機。請確認使用 HTTPS，或改用手動輸入／外接掃描器。");
      return;
    }
    const Reader = window.ZXingBrowser?.BrowserMultiFormatReader;
    if (!Reader) {
      scannerMsg("條碼辨識元件載入失敗。請確認網路可連線至 jsDelivr CDN，重新整理後再試。");
      return;
    }
    try {
      // Keep camera acquisition in the direct click flow for iOS Safari compatibility.
      await stopBarcodeScan();
      barcodeReader = new Reader();
      scannerMsg("正在啟動相機，請允許 Safari 使用相機…");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
      const video = $("camera");
      video.setAttribute("autoplay", "");
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      show("camera");
      show("stop-camera");
      await video.play();
      scannerMsg("相機已啟動，請將一維條碼或 QR Code 對準鏡頭。", true);

      // Decode the already-authorized stream instead of asking ZXing to open a second camera stream.
      barcodeControls = await barcodeReader.decodeFromStream(
        stream,
        video,
        async (result, error) => {
          if (!result || scanLocked) return;
          scanLocked = true;
          const raw = result.getText();
          const parsed = normalizeBarcode(raw);
          if (!parsed) {
            scanLocked = false;
            scannerMsg("已讀取條碼，但無法取得件號，請改用手動輸入。");
            return;
          }
          await stopBarcodeScan();
          $("keyword").value = parsed;
          show("suggestions", false);
          scannerMsg(`掃描成功，件號：${parsed}，正在查詢…`, true);
          await search();
        }
      );
    } catch (e) {
      await stopBarcodeScan();
      const name = e?.name || "";
      const detail = e?.message || String(e);
      const guidance = name === "NotAllowedError" ? "請在 iPhone 設定或 Safari 網站設定中允許相機權限。"
        : name === "NotFoundError" ? "找不到可用相機。"
        : name === "NotReadableError" ? "相機可能正被其他程式使用，請關閉其他相機 App 後重試。"
        : name === "OverconstrainedError" ? "後置相機條件不相容，請改用一般相機設定重試。"
        : "請確認 Safari 相機權限及 HTTPS 網址。";
      scannerMsg(`相機啟動失敗（${name || "Error"}）：${detail}。${guidance}`);
      console.error("Barcode scanner start failed:", e);
    }
  };

  $("stop-camera").onclick = stopBarcodeScan;
  window.addEventListener("pagehide", stopBarcodeScan);

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


  // V1.5: Inventory result query, upload, and developer-controlled availability.
  const resultHeaders = [
    "Plnt", "SLoc", "Matl Group", "MRPC", "Material", "料名",
    "庫房盤點量(含虛擬)", "線邊合計盤點量", "WIP量", "合計盤點量",
    "帳面量", "盈虧數量", "Bin", "Product Line", "Line location",
    "Bin Number", "PhysInvDoc", "Item", "Year"
  ];
  const resultFields = [
    "plnt", "sloc", "matl_group", "mrpc", "material", "material_name",
    "warehouse_qty", "line_side_qty", "wip_qty", "total_count_qty",
    "book_qty", "variance_qty", "bin", "product_line", "line_location",
    "bin_number", "phys_inv_doc", "item", "year"
  ];
  const resultIntegerFields = new Set([
    "warehouse_qty", "line_side_qty", "wip_qty",
    "total_count_qty", "book_qty", "variance_qty"
  ]);
  let resultRowsValidated = null;
  let resultPage = 1;
  let resultTotalPages = 0;
  let resultLastCriteria = null;

  function resultMessage(id, text, ok = false) {
    msg(id, text, ok);
  }

  async function loadResultQueryState() {
    if (!sb || !employee) return;
    $("result-query-state").textContent = "正在讀取盤點結果查詢設定…";
    try {
      const { data, error } = await sb
        .from("system_settings")
        .select("setting_value")
        .eq("setting_key", "inventory_result_query_enabled")
        .maybeSingle();
      if (error) throw error;
      const enabled = data?.setting_value === true;
      show("result-query-form", enabled);
      $("result-query-state").textContent = enabled
        ? "盤點結果查詢已開放。請輸入 Material 或 Bin，至少填寫一項。"
        : "目前尚未開放盤點結果查詢，請洽 DEVELOPER。";
      if (role === "DEVELOPER") {
        $("result-query-enabled").checked = enabled;
        resultMessage("result-setting-message", enabled ? "目前為開放狀態。" : "目前為關閉狀態。", true);
      }
    } catch (e) {
      $("result-query-state").textContent = "讀取查詢設定失敗：" + (e.message || e);
    }
  }

  async function loadResultUploadStatus() {
    if (!sb || !employee) return;
    try {
      const { data, error } = await sb.rpc("get_inventory_result_upload_status");
      if (error) throw error;
      const latest = data?.latest_upload;
      $("result-meta").textContent = latest
        ? `最後上傳：${new Date(latest.uploaded_at).toLocaleString("zh-TW")}｜檔案：${latest.file_name}｜上傳人：${latest.uploaded_by_name || latest.uploaded_by_employee_id}｜筆數：${latest.uploaded_rows.toLocaleString()}`
        : "尚無成功上傳紀錄。";
    } catch (e) {
      $("result-meta").textContent = "讀取上傳資訊失敗：" + (e.message || e);
    }
  }

  function isNegativeNumber(value) {
    if (value === null || value === undefined || String(value).trim() === "") return false;
    const number = Number(value);
    return Number.isFinite(number) && number < 0;
  }

  function resultCell(value, alignRight = false) {
    const text = value ?? "";
    const classes = [];
    if (alignRight) classes.push("numeric-cell");
    if (isNegativeNumber(text)) classes.push("negative-value");
    const classAttr = classes.length ? ` class="${classes.join(" ")}"` : "";
    return `<td${classAttr}>${esc(text)}</td>`;
  }

  function renderInventoryResult(data) {
    const rows = data?.data || [];
    resultPage = Number(data?.page || 1);
    resultTotalPages = Number(data?.total_pages || 0);
    $("result-page-label").textContent = `第 ${resultTotalPages ? resultPage : 0} / ${resultTotalPages} 頁｜共 ${Number(data?.total || 0).toLocaleString()} 筆`;
    $("result-prev").disabled = resultPage <= 1;
    $("result-next").disabled = resultPage >= resultTotalPages;
    if (!rows.length) {
      $("result-table").innerHTML = '<p class="empty">查無符合資料。</p>';
      return;
    }
    const columns = [
      ["material","Material",false],["material_name","料名",false],["plnt","Plnt",false],
      ["sloc","SLoc",false],["matl_group","Matl Group",false],["mrpc","MRPC",false],
      ["warehouse_qty","庫房盤點量",true],["line_side_qty","線邊合計盤點量",true],
      ["wip_qty","WIP量",true],["total_count_qty","合計盤點量",true],
      ["book_qty","帳面量",true],["variance_qty","盈虧數量",true],
      ["bin","Bin",false],["product_line","Product Line",false],
      ["line_location","Line location",false],["bin_number","Bin Number",false],
      ["phys_inv_doc","PhysInvDoc",false],["item","Item",false],["year","Year",true]
    ];
    let html = '<table class="result-data-table"><thead><tr>' +
      columns.map(c => `<th${c[2] ? ' class="numeric-cell"' : ""}>${esc(c[1])}</th>`).join("") +
      '</tr></thead><tbody>';
    for (const row of rows) {
      html += "<tr>" + columns.map(c => resultCell(row[c[0]], c[2])).join("") + "</tr>";
    }
    html += "</tbody></table>";
    $("result-table").innerHTML = html;
  }

  async function runInventoryResultSearch(page = 1) {
    if (!sb) return resultMessage("result-search-message", "尚未設定 Supabase。");
    const material = $("result-material").value.trim();
    const bin = $("result-bin").value.trim();
    if (!material && !bin) {
      $("result-table").innerHTML = '<p class="empty">請至少輸入 Material 或 Bin 查詢條件。</p>';
      resultMessage("result-search-message", "Material 與 Bin 不可同時空白。");
      return;
    }
    resultLastCriteria = { material, bin };
    resultMessage("result-search-message", "查詢中…");
    $("result-search").disabled = true;
    try {
      const { data, error } = await sb.rpc("search_inventory_result", {
        p_material: material || null,
        p_bin: bin || null,
        p_page: page
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "查詢失敗。");
      renderInventoryResult(data);
      resultMessage("result-search-message", `查詢完成，共 ${Number(data.total || 0).toLocaleString()} 筆。`, true);
    } catch (e) {
      resultMessage("result-search-message", "查詢失敗：" + (e.message || e));
    } finally {
      $("result-search").disabled = false;
    }
  }

  $("result-search").onclick = () => runInventoryResultSearch(1);
  $("result-material").addEventListener("keydown", e => { if (e.key === "Enter") runInventoryResultSearch(1); });
  $("result-bin").addEventListener("keydown", e => { if (e.key === "Enter") runInventoryResultSearch(1); });
  $("result-prev").onclick = () => runInventoryResultSearch(Math.max(1, resultPage - 1));
  $("result-next").onclick = () => runInventoryResultSearch(Math.min(resultTotalPages, resultPage + 1));
  $("result-clear").onclick = () => {
    $("result-material").value = "";
    $("result-bin").value = "";
    resultPage = 1;
    $("result-table").innerHTML = '<p class="empty">請輸入 Material 或 Bin 查詢。</p>';
    $("result-page-label").textContent = "第 0 / 0 頁";
    $("result-prev").disabled = true;
    $("result-next").disabled = true;
    resultMessage("result-search-message", "");
  };

  $("result-setting-save").onclick = async () => {
    if (role !== "DEVELOPER") return;
    const enabled = $("result-query-enabled").checked;
    $("result-setting-save").disabled = true;
    try {
      const { data, error } = await sb.rpc("set_inventory_result_query_enabled", {
        p_enabled: enabled
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "設定儲存失敗。");
      resultMessage("result-setting-message", enabled ? "已開放盤點結果查詢。" : "已關閉盤點結果查詢。", true);
      await loadResultQueryState();
    } catch (e) {
      resultMessage("result-setting-message", "設定失敗：" + (e.message || e));
      await loadResultQueryState();
    } finally {
      $("result-setting-save").disabled = false;
    }
  };

  function excelCellText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function validateInventoryResultRow(row, rowIndex) {
    const output = {};
    for (let i = 0; i < resultFields.length; i++) {
      const field = resultFields[i];
      const value = row[i];
      const text = excelCellText(value);
      if (field === "material") {
        if (!text) throw new Error(`第 ${rowIndex + 2} 列：Material 不可空白。`);
        output[field] = text;
      } else if (resultIntegerFields.has(field)) {
        if (!text) {
          output[field] = null;
        } else {
          if (!/^-?\d+$/.test(text)) throw new Error(`第 ${rowIndex + 2} 列：${resultHeaders[i]} 必須為整數，空白可留空。`);
          const n = Number(text);
          if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) {
            throw new Error(`第 ${rowIndex + 2} 列：${resultHeaders[i]} 超出 PostgreSQL integer 範圍。`);
          }
          output[field] = n;
        }
      } else if (field === "year") {
        if (!text) output[field] = null;
        else {
          if (!/^-?\d+$/.test(text)) throw new Error(`第 ${rowIndex + 2} 列：Year 必須為整數。`);
          const n = Number(text);
          if (!Number.isInteger(n) || n < -32768 || n > 32767) throw new Error(`第 ${rowIndex + 2} 列：Year 超出 smallint 範圍。`);
          output[field] = n;
        }
      } else {
        output[field] = text || null;
      }
    }
    return output;
  }

  function renderResultUploadSample(rows) {
    const cols = ["material", "material_name", "warehouse_qty", "line_side_qty", "wip_qty", "total_count_qty", "book_qty", "variance_qty", "bin", "year"];
    const numericFields = new Set(["warehouse_qty", "line_side_qty", "wip_qty", "total_count_qty", "book_qty", "variance_qty", "year"]);
    const labels = ["Material", "料名", "庫房盤點量", "線邊合計盤點量", "WIP量", "合計盤點量", "帳面量", "盈虧數量", "Bin", "Year"];
    const sample = rows.slice(0, 10);
    let html = '<table class="result-data-table result-preview-table"><thead><tr>' + labels.map((x, i) => `<th${numericFields.has(cols[i]) ? ' class="numeric-cell"' : ""}>${esc(x)}</th>`).join("") + '</tr></thead><tbody>';
    sample.forEach(row => { html += "<tr>" + cols.map(c => resultCell(row[c], numericFields.has(c))).join("") + "</tr>"; });
    html += "</tbody></table>";
    $("result-upload-sample").innerHTML = html;
    show("result-upload-sample", true);
  }

  $("result-validate").onclick = async () => {
    resultRowsValidated = null;
    $("result-replace").disabled = true;
    show("result-replace", false);
    show("result-upload-sample", false);
    const file = $("result-file").files[0];
    if (role !== "DEVELOPER") {
      $("result-upload-preview").textContent = "權限不足：僅 DEVELOPER 可上傳盤點結果。";
      return;
    }
    if (!file) {
      $("result-upload-preview").textContent = "請先選擇 Excel 檔案。";
      return;
    }
    if (!/\.xlsx?$/i.test(file.name)) {
      $("result-upload-preview").textContent = "格式錯誤：僅接受 .xlsx 或 .xls。";
      return;
    }
    try {
      if (!window.XLSX) throw new Error("Excel 解析元件載入失敗，請確認網路/CDN連線。");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, raw: true });
      const ws = wb.Sheets["盈虧清冊"];
      if (!ws) throw new Error("找不到必要工作表「盈虧清冊」。");
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
      if (!matrix.length) throw new Error("「盈虧清冊」工作表沒有內容。");
      const headers = matrix[0].map(excelCellText);
      // Verify the complete source A-U layout, while importing only A-L and N-T.
      const sourceHeaders = [
        "Plnt","SLoc","Matl Group","MRPC","Material","料名",
        "庫房盤點量(含虛擬)","線邊合計盤點量","WIP量","合計盤點量",
        "帳面量","盈虧數量","盈虧金額","Bin","Product Line",
        "Line location","Bin Number","PhysInvDoc","Item","Year","ABS"
      ];
      if (headers.length < 21 || sourceHeaders.some((h, i) => headers[i] !== h) || headers.slice(21).some(h => h !== "")) {
        throw new Error("「盈虧清冊」欄位名稱或順序不符。必要來源欄位 A～U：" + sourceHeaders.join("、"));
      }
      const sourceRows = matrix.slice(1).filter(r => r.some(v => excelCellText(v) !== ""));
      if (!sourceRows.length) throw new Error("「盈虧清冊」沒有有效資料列。");
      if (sourceRows.length > 50000) throw new Error("資料筆數超過 50,000 筆上限。");
      resultRowsValidated = sourceRows.map((row, i) => {
        const selected = row.slice(0, 12).concat(row.slice(13, 20));
        if (selected.length !== 19) throw new Error(`第 ${i + 2} 列欄位不足 19 欄。`);
        return validateInventoryResultRow(selected, i);
      });
      $("result-upload-preview").textContent =
        `格式檢查通過\n檔案：${file.name}\n工作表：盈虧清冊\n有效資料：${resultRowsValidated.length.toLocaleString()} 筆\n匯入欄位：19 欄（A～L、N～T）\n略過欄位：M 盈虧金額、U ABS\n數量欄位：整數；空白保留 NULL\n\n下方顯示前 10 筆預覽。請確認後再執行整批覆蓋。`;
      renderResultUploadSample(resultRowsValidated);
      show("result-replace", true);
      $("result-replace").disabled = false;
    } catch (e) {
      $("result-upload-preview").textContent = "格式檢查未通過\n" + (e.message || e);
    }
  };

  $("result-replace").onclick = async () => {
    if (role !== "DEVELOPER" || !resultRowsValidated) return;
    const file = $("result-file").files[0];
    const count = resultRowsValidated.length;
    if (!confirm(`即將以「${file.name}」的 ${count.toLocaleString()} 筆盤點結果，覆蓋目前全部盤點結果。此操作不可由前端復原。確定繼續？`)) return;
    const button = $("result-replace");
    button.disabled = true;
    button.textContent = "正在覆蓋，請勿關閉頁面…";
    resultMessage("result-upload-message", "正在驗證並寫入資料庫…");
    try {
      const { data, error } = await sb.rpc("replace_inventory_result", {
        p_file_name: file.name,
        p_rows: resultRowsValidated
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "資料庫拒絕上傳。");
      $("result-upload-preview").textContent =
        `盤點結果覆蓋成功\n檔案：${data.file_name}\n匯入筆數：${Number(data.uploaded_rows).toLocaleString()}\n上傳人：${data.uploaded_by}\n上傳時間：${new Date().toLocaleString("zh-TW")}`;
      resultMessage("result-upload-message", "盤點結果已成功整批覆蓋。", true);
      resultRowsValidated = null;
      $("result-file").value = "";
      show("result-replace", false);
      show("result-upload-sample", false);
      await loadResultUploadStatus();
      await loadResultQueryState();
    } catch (e) {
      resultMessage("result-upload-message", "上傳失敗，資料庫應保留原有盤點結果。原因：" + (e.message || e));
      await loadResultUploadStatus();
    } finally {
      button.disabled = false;
      button.textContent = "確認覆蓋盤點結果";
    }
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
