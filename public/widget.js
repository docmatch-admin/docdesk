/*!
 * DocDesk web chat widget
 * ใส่ในเว็บ: <script src="https://YOUR-APP/widget.js" defer></script>
 */
(function () {
  if (window.__docdesk) return;
  window.__docdesk = true;

  var script = document.currentScript;
  var API = new URL(script ? script.src : location.href).origin + "/api/webchat";
  var en = (document.documentElement.lang || "").toLowerCase().indexOf("en") === 0;
  var T = en
    ? { title: "Chat with HappiWell Clinic", hello: "Hello! How can we help you today?", ph: "Type a message…", send: "Send", open: "Chat with us", busy: "You're sending messages too quickly. Please wait a moment.", read: "Read", attach: "Attach image", tooBig: "Images must be 5MB or smaller.", badImage: "This image could not be sent. Please use JPEG, PNG, WebP or HEIC.", mediaDeleted: "Image removed under our data retention policy", imageCap: "We can't accept more images today. Please send a message or call the clinic." }
    : { title: "แชทกับแฮปปี้เวลล์ คลินิก", hello: "สวัสดีค่ะ มีอะไรให้คลินิกช่วยไหมคะ", ph: "พิมพ์ข้อความ…", send: "ส่ง", open: "แชทกับเรา", busy: "ส่งเร็วเกินไป กรุณารอสักครู่", read: "อ่านแล้ว", attach: "แนบรูป", tooBig: "รูปต้องไม่เกิน 5MB", badImage: "ส่งรูปนี้ไม่ได้ กรุณาใช้ไฟล์ JPEG, PNG, WebP หรือ HEIC", mediaDeleted: "รูปถูกลบตามนโยบายเก็บข้อมูล", imageCap: "วันนี้รับรูปครบจำนวนแล้ว กรุณาพิมพ์ข้อความหรือโทรหาคลินิก" };

  var KEY = "docdesk_session";
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, function (c) {
      return (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16);
    });
  }
  var session;
  try { session = localStorage.getItem(KEY); if (!session) { session = uuid(); localStorage.setItem(KEY, session); } }
  catch (e) { session = uuid(); }

  var css = "\
#dd-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#4A63E0;color:#fff;border:0;border-radius:999px;padding:14px 20px;font:600 16px/1 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer;display:flex;gap:8px;align-items:center}\
#dd-btn .dot{background:#E94B5C;border-radius:999px;min-width:20px;height:20px;font-size:12px;display:none;align-items:center;justify-content:center}\
#dd-panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font:16px/1.5 system-ui,sans-serif;color:#1f2430}\
#dd-panel header{background:#4A63E0;color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}\
#dd-panel header button{background:none;border:0;color:#fff;font-size:22px;cursor:pointer}\
#dd-list{flex:1;overflow-y:auto;padding:12px;background:#f5f7fb;display:flex;flex-direction:column;gap:8px}\
.dd-m{max-width:80%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}\
.dd-in{align-self:flex-end;background:#4A63E0;color:#fff;border-bottom-right-radius:4px}\
.dd-out{align-self:flex-start;background:#fff;border:1px solid #e3e7f0;border-bottom-left-radius:4px}\
.dd-read{align-self:flex-end;margin-top:-4px;font-size:11px;color:#7a8295}\
.dd-img{display:block;max-width:100%;max-height:220px;border-radius:10px;cursor:zoom-in}\
.dd-cap{margin-top:6px}\
#dd-form #dd-attach{background:none;color:#4A63E0;border:1px solid #cfd5e3;padding:0 10px;font-size:18px}\
#dd-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e7f0}\
#dd-form textarea{flex:1;resize:none;border:1px solid #cfd5e3;border-radius:10px;padding:9px 11px;font:inherit;height:44px}\
#dd-form button{background:#22C7A0;color:#fff;border:0;border-radius:10px;padding:0 16px;font:600 16px system-ui;cursor:pointer}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.id = "dd-btn";
  btn.innerHTML = "💬 <span>" + T.open + "</span><span class='dot'></span>";
  var panel = document.createElement("div");
  panel.id = "dd-panel";
  panel.innerHTML =
    "<header><span>" + T.title + "</span><button aria-label='close'>×</button></header>" +
    "<div id='dd-list'></div>" +
    "<form id='dd-form'><button type='button' id='dd-attach' aria-label='" + T.attach + "' title='" + T.attach + "'>📎</button>" +
    "<input type='file' id='dd-file' accept='image/*,.heic,.heif' style='display:none'>" +
    "<textarea placeholder='" + T.ph + "'></textarea><button type='submit'>" + T.send + "</button></form>";
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var list = panel.querySelector("#dd-list");
  var form = panel.querySelector("#dd-form");
  var input = form.querySelector("textarea");
  var dot = btn.querySelector(".dot");
  var open = false, last = null, seen = {}, unread = 0, timer = null;
  var lastIn = null, lastOutAt = null, clinicReadAt = null, seenUpTo = null;
  var readEl = document.createElement("div");
  readEl.className = "dd-read";
  readEl.textContent = T.read;

  function add(m) {
    if (seen[m.id]) return;
    seen[m.id] = 1;
    var d = document.createElement("div");
    d.className = "dd-m " + (m.direction === "in" ? "dd-in" : "dd-out");
    if (m.media_deleted) {
      d.textContent = T.mediaDeleted;
    } else if (m.preview_url) {
      var img = document.createElement("img");
      img.className = "dd-img";
      img.src = m.preview_url;
      img.alt = "";
      img.onclick = function () { window.open(m.media_url, "_blank", "noopener"); };
      d.appendChild(img);
      if (m.body) {
        var cap = document.createElement("div");
        cap.className = "dd-cap";
        cap.textContent = m.body;
        d.appendChild(cap);
      }
    } else {
      d.textContent = m.body;
    }
    list.appendChild(d);
    list.scrollTop = list.scrollHeight;
    if (m.created_at) {
      last = m.created_at;
      if (m.direction === "in") lastIn = { el: d, at: m.created_at };
      else lastOutAt = m.created_at;
    }
    if (!open && m.direction === "out") { unread++; dot.textContent = unread; dot.style.display = "inline-flex"; }
  }

  // "อ่านแล้ว" ใต้ข้อความล่าสุดของลูกค้า เมื่อคลินิกเปิดอ่านหลังข้อความนั้น
  function renderRead() {
    if (lastIn && clinicReadAt && new Date(clinicReadAt) >= new Date(lastIn.at)) {
      if (lastIn.el.nextSibling !== readEl) list.insertBefore(readEl, lastIn.el.nextSibling);
    } else if (readEl.parentNode) {
      list.removeChild(readEl);
    }
  }

  // แจ้งคลินิกเมื่อลูกค้าเห็นข้อความจริง: หน้าต่างแชทเปิดอยู่และแท็บไม่ได้ถูกซ่อน
  function reportSeen() {
    if (!open || document.hidden || !lastOutAt || lastOutAt === seenUpTo) return;
    seenUpTo = lastOutAt;
    fetch(API + "/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session, upTo: lastOutAt }) })
      .catch(function () { seenUpTo = null; });
  }
  document.addEventListener("visibilitychange", reportSeen);

  function poll() {
    var url = API + "?session=" + session + (last ? "&after=" + encodeURIComponent(last) : "");
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      (j.messages || []).forEach(add);
      if (j.clinic_read_at) clinicReadAt = j.clinic_read_at;
      renderRead();
      reportSeen();
    })
      .catch(function () {})
      .finally(function () { timer = setTimeout(poll, open ? 3000 : 15000); });
  }

  add({ id: "hello", direction: "out", body: T.hello });
  unread = 0; dot.style.display = "none";

  function toggle(v) {
    open = v;
    panel.style.display = v ? "flex" : "none";
    if (v) { unread = 0; dot.style.display = "none"; input.focus(); clearTimeout(timer); poll(); }
  }
  btn.onclick = function () { toggle(!open); };
  panel.querySelector("header button").onclick = function () { toggle(false); };

  function send(e) {
    if (e) e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session, text: text }) })
      .then(function (r) {
        if (r.status === 429) {
          // คืนข้อความให้ลูกค้าส่งใหม่ได้โดยไม่ต้องพิมพ์ซ้ำ
          if (!input.value) input.value = text;
          add({ id: "busy-" + Date.now(), direction: "out", body: T.busy });
          return;
        }
        clearTimeout(timer); poll();
      });
  }
  form.onsubmit = send;

  // รูป: ขอช่องอัปโหลด (นับ rate limit) → อัปโหลดตรงเข้า Storage → แจ้ง server ให้ตรวจและเก็บ
  var fileInput = form.querySelector("#dd-file");
  var MAX_IMAGE = 5 * 1024 * 1024;
  function note(text) { add({ id: "note-" + Date.now(), direction: "out", body: text }); }
  function postUpload(body) {
    return fetch(API + "/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function uploadImage(file) {
    if (file.size > MAX_IMAGE) { note(T.tooBig); return Promise.resolve(); }
    return postUpload({ session: session }).then(function (r) {
      if (r.status === 429) {
        return r.json().catch(function () { return null; }).then(function (j) {
          note(j && j.error === "image_cap" ? T.imageCap : T.busy);
        });
      }
      if (!r.ok) { note(T.badImage); return; }
      return r.json().then(function (slot) {
        return fetch(slot.url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file })
          .then(function (put) {
            if (!put.ok) throw new Error("upload failed");
            return postUpload({ session: session, path: slot.path });
          })
          .then(function (done) {
            if (!done.ok) { note(T.badImage); return; }
            clearTimeout(timer); poll();
          });
      });
    }).catch(function () { note(T.badImage); });
  }
  form.querySelector("#dd-attach").onclick = function () { fileInput.click(); };
  fileInput.onchange = function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) uploadImage(file);
  };
  input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) send(e); });

  poll();
})();
