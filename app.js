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

  function enterWorkspace() {
    show("login-panel", false);
    show("workspace");
    show("logout");
    $("session-label").textContent = `工號：${employee}｜${role}`;
    show("admin-panel", role === "ADMIN" || role === "DEVELOPER");
    show("developer-panel", role === "DEVELOPER");
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
          <div class="info"><small>廠區 Plnt</small><strong>${esc(first.plnt)}</strong></div>
          <div class="info"><small>物料群</small><strong>${esc(first.matl_group)}</strong></div>
          <div class="info"><small>車型 MRPCn</small><strong>${esc(first.mrpcn)}</strong></div>
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
