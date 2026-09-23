// public/app.js — نظام تسجيل الجودة
//
// Server-backed. The views, filters, charts and Excel export are the
// prototype's, unchanged; the data layer below them reads from the API
// instead of localStorage. See public/api.js for the transport.
const nowLocal=new Date();
/** The browser's own date. Used only for the first paint, until the server's arrives. */
function localToday(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const delayReasons=['إحالة الطلب إلى جهة أخرى للاعتماد أو المراجعة','غياب الموظف المسؤول أو تغيير المسؤول عن الطلب','نقص المعلومات أو المستندات المطلوبة','طلب استكمال بيانات إضافية من مقدم الطلب','مشكلات تقنية أو أعطال في الأنظمة الإلكترونية','الحاجة إلى وقت إضافي لاستكمال الطلب','تأخير في الموافقات الداخلية أو الخارجية','تحديث السياسات أو اللوائح المتعلقة بنوع الطلب','أسباب أخرى'];
const holidayTypes=['رأس السنة الميلادية','عيد الفطر','عيد الأضحى','رأس السنة الهجرية','عاشوراء','المولد النبوي الشريف','العيد الوطني','أخرى'];
const roleLabels={user:'مستخدم',supervisor:'مشرف قسم',power:'Power User'};
// initialData() and seedRequests() lived here. The reference data and the
// sample requests are now created by server/scripts/seed.js against the
// database, so there is one set of starting data rather than one per browser.

// ── Dates ─────────────────────────────────────────────────────
//
// These are the prototype's, kept for what the screen still has to work out for
// itself: the end date preview while someone types a holiday's length, and
// which open requests count as "تستحق قريباً".
//
// What they are NO LONGER used for is the three numbers that matter — whether a
// request is late, how many working days it is late by, and whether it was
// closed on time. Those arrive already computed on every request
// (`isLate`, `currentDelayDays`, `isDueSoon`), worked out by the server from the
// holiday calendar in the database. The functions below are a convenience; the
// server is the authority, and the two cannot disagree because the screen no
// longer has its own opinion.
function toDate(s){return new Date(s+'T12:00:00')}
function fmt(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function addCalendarDays(start,n){let d=toDate(start);d.setDate(d.getDate()+Math.max(0,n-1));return fmt(d)}
function inHoliday(date,h){return date>=h.startDate&&date<=h.endDate}
function dayIsWork(d,data){let day=d.getDay(),ds=fmt(d);if(day===5||day===6)return false;return !(data.holidays||[]).some(h=>inHoliday(ds,h))}
function addWork(start,n,data){let d=toDate(start),c=0;while(c<n){d.setDate(d.getDate()+1);if(dayIsWork(d,data))c++}return fmt(d)}
function workBetween(start,end,data){let d=toDate(start),e=toDate(end),c=0;while(d<e){d.setDate(d.getDate()+1);if(dayIsWork(d,data))c++}return c}

// Read the server's answer when it is there, and fall back to computing it only
// so these keep working if called before the first snapshot arrives.
function calendarLate(r){
 if(r.isLate!==undefined)return r.isLate;
 return r.status==='Closed'?Boolean(r.closeDate&&r.closeDate>r.dueDate):(r.status==='Open'&&r.dueDate<TODAY)}
function currentDelayDays(r,data){
 if(r.currentDelayDays!==undefined)return r.currentDelayDays;
 if(r.status==='Closed')return Number(r.delayDays||0);
 return r.status==='Open'&&r.dueDate<TODAY?workBetween(r.dueDate,TODAY,data):0}
function delayDisplay(r,data){return calendarLate(r)?String(currentDelayDays(r,data)):'-'}

function depName(d,id){return (d.departments||[]).find(x=>x.id===Number(id))?.name||'-'}
function roleName(r){return roleLabels[r]||r}
// Which password opens this system for this account. Three answers, not two: an
// AD row that مدير النظام gave a local password to is neither an ordinary local
// account nor still signing in through the directory, and reading it as either
// one hides the thing an administrator needs to see.
function loginMethod(x){return x.isLdap?'Active Directory':x.adPasswordOverride?'محلية (تتجاوز الدليل)':'كلمة مرور محلية'}
function maxId(arr){return arr.length?Math.max(...arr.map(x=>Number(x.id)||0)):0}
// ── Data layer ────────────────────────────────────────────────
//
// This block used to read and write localStorage. It now holds one snapshot
// fetched from the server, and every write goes back through the API.
//
// The snapshot keeps the SAME shape the prototype used, on purpose: every view,
// filter, chart and Excel export below reads d.requests, d.users,
// d.departments, d.services, d.holidays and d.audits exactly as before, and
// none of them had to change. render() is still synchronous — it draws from
// whatever DATA currently holds — and a mutation is "call the API, refresh the
// snapshot, render", so the screen shows what the server actually accepted
// rather than what the browser hoped it would.
let DATA = null;      // the server's snapshot
let ME   = null;      // the signed-in user, as the server sees them
let CAN  = {};        // what the server says this user may do

// The prototype computed TODAY from the browser's clock. Every date comparison
// on screen now uses the server's, so a wrong clock on one machine cannot make
// a request look late there and on time everywhere else.
let TODAY = localToday();

/** Fetches the snapshot. Called at startup and after every successful write. */
async function refresh(){
 const b = await API.bootstrap();
 ME    = b.user;
 CAN   = b.can || {};
 TODAY = b.today || localToday();
 DATA  = {
  requests:    b.requests    || [],
  users:       b.users       || [],
  departments: b.departments || [],
  services:    b.services    || [],
  holidays:    b.holidays    || [],
  audits:      DATA ? DATA.audits : [],   // loaded on demand by the سجل التدقيق tab
  reference:   b.reference   || {},
 };
 return DATA;
}

/** The snapshot, synchronously — what every view below already expects. */
function load(){return DATA}

/** Writing is the server's job now. Kept as a no-op so untouched view code that
 *  still calls save(d) does not have to be hunted down; such a local tweak
 *  simply does not persist, and the next refresh() overwrites it. */
function save(){}

function user(){return ME}

/** The audit trail is written server-side, inside the operation being recorded —
 *  a log the browser appends to is a log that stops existing when the request
 *  fails halfway. A no-op here for the same reason as save(). */
function audit(){}

/** Deadlines are recomputed by the server whenever the holiday calendar
 *  changes, so the client no longer does it. */
function recalcOpenDueDates(){}

/** Runs a write, then re-reads and redraws. One helper, so no handler can
 *  forget the refresh and leave the screen showing data the server rejected.
 *
 *  `onSuccess` runs after the refresh and BEFORE the render — that is what it is
 *  for. render() clears state.flash on its way out, so a handler that adjusted
 *  state afterwards and rendered a second time wiped the message it had just
 *  set; the holiday screen's "N deadlines recalculated" vanished that way.
 *  Everything a successful write changes must therefore happen here, in the one
 *  render. */
async function mutate(fn, successText, onSuccess){
 try{
  const result = await fn();
  await refresh();
  if(onSuccess) onSuccess(result);
  if(successText) state.flash = {type:'success', text: typeof successText==='function' ? successText(result) : successText};
  render();
  return result;
 }catch(e){
  // A refusal from the server carries a message written for the person reading
  // it, so it is shown as-is rather than replaced with a generic one. The form
  // is deliberately left open, with what was typed still in it.
  state.flash = {type:'danger', text: e.message || 'تعذّر تنفيذ العملية.'};
  render();
  return null;
 }
}

/** Closes the admin form on success. Passed to mutate() by the four edit forms. */
const closeAdminForm = () => { state.adminForm = null; };
function xmlEscape(v){return String(v??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')}
function bytesConcat(parts){let len=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(len),o=0;parts.forEach(p=>{out.set(p,o);o+=p.length});return out}
function le16(n){let b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n,true);return b}
function le32(n){let b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n>>>0,true);return b}
const CRC_TABLE=(()=>{let t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0}return t})();
function crc32(bytes){let c=0xFFFFFFFF;for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function zipStore(files){let enc=new TextEncoder(),locals=[],centrals=[],offset=0;for(let f of files){let name=enc.encode(f.name),data=enc.encode(f.data),crc=crc32(data),flags=0x0800;let local=bytesConcat([le32(0x04034b50),le16(20),le16(flags),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),name,data]);locals.push(local);let central=bytesConcat([le32(0x02014b50),le16(20),le16(20),le16(flags),le16(0),le16(0),le16(0),le32(crc),le32(data.length),le32(data.length),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]);centrals.push(central);offset+=local.length}let centralSize=centrals.reduce((n,p)=>n+p.length,0),eocd=bytesConcat([le32(0x06054b50),le16(0),le16(0),le16(files.length),le16(files.length),le32(centralSize),le32(offset),le16(0)]);return bytesConcat([...locals,...centrals,eocd])}
function colLetter(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}
function buildXlsxBytes(matrix,sheetName='البيانات'){
 let rows=matrix.map((row,ri)=>`<row r="${ri+1}">${row.map((v,ci)=>`<c r="${colLetter(ci+1)}${ri+1}" t="inlineStr"${ri===0?' s="1"':''}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`).join('')}</row>`).join('');
 let sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews><sheetData>${rows}</sheetData></worksheet>`;
 let workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName).slice(0,31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
 let styles=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
 let files=[
 {name:'[Content_Types].xml',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`},
 {name:'_rels/.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
 {name:'xl/workbook.xml',data:workbook},
 {name:'xl/_rels/workbook.xml.rels',data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
 {name:'xl/styles.xml',data:styles},{name:'xl/worksheets/sheet1.xml',data:sheet}
 ];return zipStore(files)
}
function downloadXlsx(matrix,fileBase,sheetName='البيانات'){if(!matrix||matrix.length<2){alert('لا توجد بيانات ظاهرة للتصدير.');return}let bytes=buildXlsxBytes(matrix,sheetName),blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${fileBase}_${TODAY}.xlsx`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}

function downloadXlsx(matrix,fileBase,sheetName='البيانات'){if(!matrix||matrix.length<2){alert('لا توجد بيانات ظاهرة للتصدير.');return}let bytes=buildXlsxBytes(matrix,sheetName),blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${fileBase}_${TODAY}.xlsx`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
/** Rows the requests table draws at a time. A Power User's list is the whole
 *  organisation, 10,000+ rows, and drawing every one cost most of a second on
 *  each click. The cards, charts and Excel export still count every row. */
const DASH_PAGE=200;
let state={view:'dashboard',dashLimit:DASH_PAGE,reqCode:null,adminTab:'users',flash:null,search:'',dashDepartment:'all',dashEmployee:'all',dashService:'all',dashStatus:'all',dashReqCode:'',dashDateFrom:'',dashDateTo:'',adminSearch:'',adminDept:'all',adminRole:'all',adminStatus:'all',adminForm:null,newDraft:{serviceId:'',requestDate:TODAY,subject:'',notes:''}};
let adminSearchTimer=null;
function resetDashboardFilters(){state.search='';state.dashDepartment='all';state.dashEmployee='all';state.dashService='all';state.dashStatus='all';state.dashReqCode='';state.dashDateFrom='';state.dashDateTo='';state.dashLimit=DASH_PAGE}
function baseVisibleRequests(d,u){if(u.role==='power')return d.requests;if(u.role==='supervisor')return d.requests.filter(r=>r.departmentId===u.departmentId);return d.requests.filter(r=>r.userId===u.id)}
function dueSoon(r,d){let cutoff=addWork(TODAY,2,d);return r.status==='Open'&&r.dueDate>=TODAY&&r.dueDate<=cutoff}
function matchesDashStatus(r,d,status){if(status==='all')return true;if(status==='Open')return r.status==='Open';if(status==='Closed')return r.status==='Closed';if(status==='Overdue')return r.status==='Open'&&r.dueDate<TODAY;if(status==='DueSoon')return dueSoon(r,d);return true}
function effectiveDepartment(u){return u.role==='power'?state.dashDepartment:String(u.departmentId)}
function filteredRequests(d,u,ignoreStatus=false){let rows=baseVisibleRequests(d,u).slice();
 if(u.role==='power'&&state.dashDepartment!=='all')rows=rows.filter(r=>String(r.departmentId)===String(state.dashDepartment));
 if(u.role!=='user'&&state.dashEmployee!=='all')rows=rows.filter(r=>String(r.userId)===String(state.dashEmployee));
 if(state.dashService!=='all')rows=rows.filter(r=>String(r.serviceId)===String(state.dashService));
 if(!ignoreStatus&&state.dashStatus!=='all')rows=rows.filter(r=>matchesDashStatus(r,d,state.dashStatus));
 if(state.dashReqCode.trim())rows=rows.filter(r=>r.reqCode.includes(state.dashReqCode.trim()));
 if(state.dashDateFrom)rows=rows.filter(r=>r.requestDate>=state.dashDateFrom);
 if(state.dashDateTo)rows=rows.filter(r=>r.requestDate<=state.dashDateTo);
 let q=state.search.trim().toLowerCase();if(q)rows=rows.filter(r=>[r.subject,r.serviceName].some(v=>String(v||'').toLowerCase().includes(q)));
 return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
function requestExportMatrix(d,u){let rows=filteredRequests(d,u);let header=['رقم الطلب','مقدم الطلب','البريد الرسمي','القسم','كود الخدمة','الخدمة','مدة الخدمة (يوم عمل)','الموضوع','تاريخ الطلب','الموعد النهائي','الحالة','تاريخ الإغلاق','وقت تسجيل الإغلاق','الإنجاز في الوقت','أيام التأخير','سبب التأخير','السبب الآخر','ملاحظات الطلب','ملاحظات الإغلاق'];return [header,...rows.map(r=>[r.reqCode,r.requesterName,r.officeEmail,r.departmentSnapshot,r.serviceCode,r.serviceName,r.duration,r.subject,r.requestDate,r.dueDate,r.status==='Closed'?'مغلق':(r.dueDate<TODAY?'مفتوح - متأخر':'مفتوح'),r.closeDate||'',r.closedAt||'',r.status==='Closed'?(r.isOnTime?'نعم':'لا'):'',calendarLate(r)?currentDelayDays(r,d):'',r.delayReason||'',r.otherDelayReason||'',r.notes||'',r.closureNotes||''])]}
function dashboardExportName(u){return u.role==='user'?'طلبات_المستخدم':u.role==='supervisor'?'طلبات_القسم':'طلبات_المؤسسة'}
function exportRequestsXlsx(d,u){downloadXlsx(requestExportMatrix(d,u),dashboardExportName(u),'الطلبات')}
function adminRows(d){let q=state.adminSearch.trim().toLowerCase();if(state.adminTab==='users')return d.users.filter(x=>(state.adminDept==='all'||String(x.departmentId)===String(state.adminDept))&&(state.adminRole==='all'||x.role===state.adminRole)&&(state.adminStatus==='all'||(state.adminStatus==='active'?x.active:!x.active))&&(!q||[x.name,x.email,depName(d,x.departmentId),roleName(x.role)].some(v=>String(v).toLowerCase().includes(q))));if(state.adminTab==='departments')return d.departments.filter(x=>(state.adminStatus==='all'||(state.adminStatus==='active'?x.active:!x.active))&&(!q||[x.name,x.prefix].some(v=>String(v).toLowerCase().includes(q))));if(state.adminTab==='services')return d.services.filter(x=>(state.adminDept==='all'||String(x.departmentId)===String(state.adminDept))&&(state.adminStatus==='all'||(state.adminStatus==='active'?x.active:!x.active))&&(!q||[x.code,x.name,depName(d,x.departmentId)].some(v=>String(v).toLowerCase().includes(q))));if(state.adminTab==='holidays')return d.holidays.filter(x=>!q||[x.name,x.type,x.startDate,x.endDate].some(v=>String(v).toLowerCase().includes(q)));if(state.adminTab==='audit')return d.audits.slice().reverse().filter(x=>!q||[x.timestamp,x.actor,x.action,x.target,x.oldValue,x.newValue].some(v=>String(v).toLowerCase().includes(q)));return []}
function adminExportMatrix(d){let rows=adminRows(d);if(state.adminTab==='users')return [['الاسم','البريد','القسم','الدور','مدير نظام','الحالة','طريقة الدخول','تغيير كلمة المرور إجباري'],...rows.map(x=>[x.name,x.email,depName(d,x.departmentId),roleName(x.role),x.admin?'نعم':'لا',x.active?'فعال':'غير فعال',loginMethod(x),x.forcePasswordChange?'نعم':'لا'])];if(state.adminTab==='departments')return [['القسم','البادئة','الحالة'],...rows.map(x=>[x.name,x.prefix,x.active?'فعال':'غير فعال'])];if(state.adminTab==='services')return [['الكود','الخدمة','القسم','المدة','الحالة'],...rows.map(x=>[x.code,x.name,depName(d,x.departmentId),x.duration,x.active?'فعال':'غير فعال'])];if(state.adminTab==='holidays')return [['العطلة','النوع','تاريخ البداية','المدة (يوم تقويمي)','تاريخ النهاية'],...rows.map(x=>[x.name,x.type,x.startDate,x.duration,x.endDate])];return [['التاريخ والوقت','المنفذ','الإجراء','الهدف','القيمة القديمة','القيمة الجديدة'],...rows.map(x=>[x.timestamp,x.actor,x.action,x.target,x.oldValue,x.newValue])];}
function exportAdminXlsx(d){let names={users:'المستخدمون',departments:'الأقسام',services:'الخدمات',holidays:'العطلات_الرسمية',audit:'سجل_التدقيق'},sheetNames={users:'المستخدمون',departments:'الأقسام',services:'الخدمات',holidays:'العطلات الرسمية',audit:'سجل التدقيق'};downloadXlsx(adminExportMatrix(d),names[state.adminTab],sheetNames[state.adminTab])}
function userReadableSnapshot(d,x){return {name:x.name,email:x.email,department:depName(d,x.departmentId),role:roleName(x.role),admin:x.admin?'نعم':'لا',active:x.active?'فعال':'غير فعال',force:x.forcePasswordChange?'نعم':'لا'}}
function readableUserDiff(before,after){let labels={name:'الاسم',email:'البريد الرسمي',department:'القسم',role:'الدور',admin:'مدير نظام',active:'الحالة',force:'إجبار تغيير كلمة المرور'},keys=Object.keys(labels).filter(k=>String(before[k])!==String(after[k]));if(!keys.length)return {oldText:'لا تغيير',newText:'لا تغيير'};return {oldText:keys.map(k=>`${labels[k]}: ${before[k]}`).join(' | '),newText:keys.map(k=>`${labels[k]}: ${after[k]}`).join(' | ')}}
function profileBadge(d,u){if(u.role==='supervisor')return `مشرف قسم — ${depName(d,u.departmentId)}`;return `${roleName(u.role)}${u.admin?' + مدير نظام':''}`}
/** The directorate's logo (public/logo.png) — sidebar and sign-in screens. */
function logoImg(cls){return `<img class="${cls}" src="logo.png" alt="الإدارة العامة للأوقاف السنية">`}
function shell(content,d,u){return `<div class="layout"><aside class="sidebar"><div class="brand">${logoImg('brand-logo')}نظام تسجيل الجودة<div class="muted">نظام متابعة طلبات الجودة</div></div><div class="nav"><button data-nav="dashboard" class="${state.view==='dashboard'?'active':''}">لوحة التحكم</button><button data-nav="new" class="${state.view==='new'?'active':''}">تسجيل طلب جديد</button>${u.admin?`<button data-nav="admin" class="${state.view==='admin'?'active':''}">إدارة النظام</button>`:''}<button id="refreshData">تحديث البيانات</button><button id="logout">تسجيل الخروج</button></div></aside><main class="content"><div class="topbar"><div><strong>${u.name}</strong><div class="small muted">${u.email} • ${depName(d,u.departmentId)}</div></div><span class="badge">${profileBadge(d,u)}</span></div>${state.flash?`<div class="alert ${state.flash.type}">${state.flash.text}</div>`:''}${content}</main></div>`}
// type="text", not type="email": an Active Directory account signs in with a
// username like "a.alkubaesy", which the browser's email validation refuses
// outright — the form would never submit and the server would never be asked.
// The server accepts either spelling.
function loginView(){return `<div class="login-wrap"><div class="login-card"><div class="login-head">${logoImg('login-logo')}<h1>نظام تسجيل الجودة</h1><p class="muted">استخدم حساب الدليل النشط أو حسابك المحلي للدخول.</p></div><div id="loginErr" aria-live="polite"></div><form id="loginForm"><label for="loginIdentifier">اسم المستخدم أو البريد الرسمي</label><input id="loginIdentifier" name="email" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required><label for="loginPassword">كلمة المرور</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required><button class="primary full-btn">تسجيل الدخول</button></form><p class="small muted login-help">للمساعدة في تسجيل الدخول، تواصل مع مسؤول النظام.</p></div></div>`}
function forcePasswordView(){return `<div class="login-wrap"><div class="login-card"><div class="login-head">${logoImg('login-logo')}<h1>تغيير كلمة المرور مطلوب</h1><p class="muted">تم تعيين كلمة مرور مؤقتة لهذا الحساب.</p></div><div id="forceErr"></div><form id="forcePasswordForm"><label>كلمة المرور الجديدة</label><input type="password" name="password" minlength="6" required><label>تأكيد كلمة المرور</label><input type="password" name="confirmPassword" minlength="6" required><button class="primary full-btn">حفظ كلمة المرور</button></form></div></div>`}
// The self-service "تغيير كلمة المرور" screen used to live here. It is gone on
// purpose: passwords are set by مدير النظام on the المستخدمون screen, for every
// account including his own. forcePasswordView above is what remains — the one
// password an ordinary user types into this system is the temporary one, once.
// The server refuses a self-service change too (POST /api/auth/password), so
// removing the screen is not the whole of the rule.
function cardMetrics(rows,d){let open=rows.filter(r=>r.status==='Open'),closed=rows.filter(r=>r.status==='Closed'),over=open.filter(r=>r.dueDate<TODAY),soon=open.filter(r=>dueSoon(r,d)),ont=closed.filter(r=>r.isOnTime).length,pct=closed.length?Math.round(ont/closed.length*1000)/10:0;return {open,closed,over,soon,pct}}
function dashboardFilterBar(d,u){let depLocked=u.role!=='power',selectedDep=depLocked?String(u.departmentId):String(state.dashDepartment),deps=d.departments.filter(x=>x.active),staff=u.role==='user'?[u]:d.users.filter(x=>x.active&&(u.role==='supervisor'?x.departmentId===u.departmentId:(state.dashDepartment==='all'||String(x.departmentId)===String(state.dashDepartment)))),services=d.services.filter(x=>x.active&&(depLocked?x.departmentId===u.departmentId:(state.dashDepartment==='all'||String(x.departmentId)===String(state.dashDepartment)))),title=u.role==='user'?'تصفية طلباتي':u.role==='supervisor'?'تصفية طلبات القسم':'تصفية المستخدم الشامل';let employeeValue=u.role==='user'?String(u.id):String(state.dashEmployee);return `<div class="filter-panel"><h3>${title}</h3><div class="filter-grid"><div><label>القسم</label><select id="dashDepartment" ${depLocked?'disabled':''}>${depLocked?`<option value="${u.departmentId}">${depName(d,u.departmentId)}</option>`:`<option value="all">جميع الأقسام</option>${deps.map(x=>`<option value="${x.id}" ${selectedDep===String(x.id)?'selected':''}>${x.name}</option>`).join('')}`}</select></div><div><label>الموظف</label><select id="dashEmployee" ${u.role==='user'?'disabled':''}>${u.role==='user'?`<option value="${u.id}">${u.name}</option>`:`<option value="all">جميع الموظفين</option>${staff.map(x=>`<option value="${x.id}" ${employeeValue===String(x.id)?'selected':''}>${x.name}</option>`).join('')}`}</select></div><div><label>الخدمة</label><select id="dashService"><option value="all">جميع الخدمات</option>${services.map(x=>`<option value="${x.id}" ${String(state.dashService)===String(x.id)?'selected':''}>${x.code} - ${x.name}</option>`).join('')}</select></div><div><label>الحالة</label><select id="dashStatus"><option value="all" ${state.dashStatus==='all'?'selected':''}>جميع الحالات</option><option value="Open" ${state.dashStatus==='Open'?'selected':''}>مفتوح</option><option value="Closed" ${state.dashStatus==='Closed'?'selected':''}>مغلق</option><option value="Overdue" ${state.dashStatus==='Overdue'?'selected':''}>متأخر</option><option value="DueSoon" ${state.dashStatus==='DueSoon'?'selected':''}>تستحق قريباً</option></select></div><div><label>رقم الطلب</label><input id="dashReqCode" value="${xSafe(state.dashReqCode)}" placeholder="مثال: 26010013"></div><div><label>بحث في الطلب</label><input id="dashSearch" value="${xSafe(state.search)}" placeholder="الموضوع أو اسم الخدمة"></div><div><label>تاريخ الطلب من</label><input id="dashDateFrom" type="date" value="${state.dashDateFrom}"></div><div><label>تاريخ الطلب إلى</label><input id="dashDateTo" type="date" value="${state.dashDateTo}"></div><div class="filter-reset"><button class="primary" id="applyDashboardFilters">تطبيق</button></div><div class="filter-reset"><button class="secondary-btn" id="clearDashboardFilters">مسح الفلاتر</button></div></div><div class="small muted filter-tip">يمكن كتابة رقم الطلب أو عبارة البحث كاملة ثم الضغط على تطبيق أو Enter. جميع النتائج والتقارير تعتمد على الفلاتر الحالية.</div></div>`}
function simpleBars(items,labelKey,valueKey){let max=Math.max(1,...items.map(x=>x[valueKey]));return items.length?items.map(x=>`<div class="bar-row"><span>${xSafe(x[labelKey])}</span><div class="bar-track"><i style="width:${Math.round(x[valueKey]/max*100)}%"></i></div><b>${x[valueKey]}</b></div>`).join(''):'<div class="empty-small">لا توجد بيانات</div>'}
function xSafe(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function chartsView(rows,d){let open=rows.filter(r=>r.status==='Open').length,closed=rows.filter(r=>r.status==='Closed').length,total=Math.max(1,open+closed);let serviceMap={};rows.forEach(r=>serviceMap[r.serviceName]=(serviceMap[r.serviceName]||0)+1);let services=Object.entries(serviceMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);let monthMap={};rows.forEach(r=>{let m=r.requestDate.slice(0,7);monthMap[m]=(monthMap[m]||0)+1});let months=Object.entries(monthMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,count])=>({month,count}));return `<div class="charts-grid"><section class="chart-card"><h3>المفتوحة مقابل المغلقة</h3><div class="split-chart"><div><span>مفتوحة</span><b>${open}</b><i style="width:${Math.round(open/total*100)}%"></i></div><div><span>مغلقة</span><b>${closed}</b><i style="width:${Math.round(closed/total*100)}%"></i></div></div></section><section class="chart-card"><h3>الطلبات حسب الخدمة</h3>${simpleBars(services,'name','count')}</section><section class="chart-card"><h3>الاتجاه الشهري</h3>${simpleBars(months,'month','count')}</section></div>`}
function departmentPerformance(rows,d){let groups={};rows.forEach(r=>{let k=r.departmentId;groups[k]=groups[k]||[];groups[k].push(r)});let list=Object.entries(groups).map(([id,rr])=>{let m=cardMetrics(rr,d);return {name:rr[0]?.departmentSnapshot||depName(d,id),total:rr.length,open:m.open.length,closed:m.closed.length,over:m.over.length,pct:m.pct}}).sort((a,b)=>b.total-a.total);return `<section><h2>أداء الأقسام</h2><div class="table-wrap"><table><thead><tr><th>القسم</th><th>الإجمالي</th><th>المفتوحة</th><th>المغلقة</th><th>المتأخرة</th><th>الإنجاز في الوقت</th></tr></thead><tbody>${list.map(x=>`<tr><td>${x.name}</td><td>${x.total}</td><td>${x.open}</td><td>${x.closed}</td><td>${x.over}</td><td>${x.pct}%</td></tr>`).join('')||'<tr><td colspan="6" class="empty">لا توجد بيانات</td></tr>'}</tbody></table></div></section>`}
function dashboard(d,u){let rows=filteredRequests(d,u),metricRows=rows,m=cardMetrics(metricRows,d),showEmployee=u.role!=='user',showDepartment=u.role==='power',active=state.dashStatus;let card=(label,val,filter,cls='')=>`<button type="button" class="card clickable ${cls} ${active===filter?'selected-filter':''}" data-card-filter="${filter}" aria-pressed="${active===filter}"><span>${label}</span><b>${val}</b></button>`;return `<div class="page-title"><div><h1>لوحة التحكم</h1><p>متابعة الطلبات حسب صلاحيات المستخدم والفلاتر الحالية.</p></div><div class="page-actions"><button class="primary" data-nav="new">+ طلب جديد</button><button class="primary export-btn" id="exportRequests">تصدير إلى Excel</button></div></div><div class="cards">${card('إجمالي الطلبات',metricRows.length,'all')}${card('المفتوحة',m.open.length,'Open')}${card('المغلقة',m.closed.length,'Closed')}${card('المتأخرة',m.over.length,'Overdue','warn')}${card('تستحق قريباً',m.soon.length,'DueSoon')}<div class="card"><span>الإنجاز في الوقت</span><b>${m.closed.length?m.pct+'%':'-'}</b></div></div><details class="filter-panel"><summary>البحث والفلاتر المتقدمة</summary>${dashboardFilterBar(d,u)}</details><section><div class="section-head"><h2>الطلبات</h2><div class="small muted">${rows.length} طلب مطابق للفلاتر الحالية${rows.length>state.dashLimit?` — يُعرض أحدث ${state.dashLimit}`:''}</div></div><div class="table-wrap"><table id="reqTable"><thead><tr><th>رقم الطلب</th>${showEmployee?'<th>الموظف</th>':''}${showDepartment?'<th>القسم</th>':''}<th>الخدمة</th><th>الموضوع</th><th>تاريخ الطلب</th><th>الموعد النهائي</th><th>الحالة</th><th>أيام التأخير</th><th>الإجراء</th></tr></thead><tbody>${rows.slice(0,state.dashLimit).map(r=>`<tr><td>${r.reqCode}</td>${showEmployee?`<td>${r.requesterName}${r.userId===u.id?' <span class="mini-own">طلبي</span>':''}</td>`:''}${showDepartment?`<td>${r.departmentSnapshot}</td>`:''}<td>${r.serviceName}</td><td>${r.subject}</td><td class="nowrap">${r.requestDate}</td><td class="nowrap">${r.dueDate}</td><td><span class="status ${r.status==='Closed'?'closed':'open'}">${r.status==='Closed'?'مغلق':'مفتوح'}</span>${r.status==='Open'&&r.dueDate<TODAY?'<span class="status late">متأخر</span>':''}</td><td>${calendarLate(r)?`<strong class="delay-days">${currentDelayDays(r,d)}</strong>`:'-'}</td><td><button type="button" class="link-button" data-open="${r.reqCode}">عرض</button></td></tr>`).join('')||`<tr><td colspan="${showDepartment?10:showEmployee?9:8}" class="empty">لا توجد طلبات مطابقة</td></tr>`}</tbody></table></div>${rows.length>state.dashLimit?`<div class="show-more"><button type="button" class="secondary-btn" id="showMoreRequests">عرض المزيد</button></div>`:''}</section>${u.role==='supervisor'||u.role==='power'?chartsView(rows,d):''}${u.role==='power'?departmentPerformance(rows,d):''}`}
function newView(d,u){let sv=d.services.filter(s=>s.departmentId===u.departmentId&&s.active),draft=state.newDraft,duration=sv.find(s=>String(s.id)===String(draft.serviceId))?.duration,due=duration&&draft.requestDate?addWork(draft.requestDate,duration,d):'';return `<div class="page-title"><div><h1>تسجيل طلب جديد</h1><p>سيتم إنشاء رقم الطلب والموعد النهائي تلقائياً.</p></div><button type="button" class="secondary-btn" data-nav="dashboard">العودة إلى الطلبات</button></div><section class="form-card"><form id="newForm"><div class="grid2"><div><label for="requesterName">مقدم الطلب</label><input id="requesterName" value="${xSafe(u.name)}" disabled></div><div><label for="requesterEmail">البريد الرسمي</label><input id="requesterEmail" value="${xSafe(u.email)}" disabled></div><div><label for="requestDepartment">القسم المعني</label><input id="requestDepartment" value="${xSafe(depName(d,u.departmentId))}" disabled></div><div><label for="requestService">نوع الخدمة *</label><select id="requestService" name="serviceId" required><option value="">اختر الخدمة</option>${sv.map(s=>`<option value="${s.id}" ${String(draft.serviceId)===String(s.id)?'selected':''}>${s.code} - ${s.name} (${s.duration} يوم عمل)</option>`).join('')}</select></div><div><label for="requestDate">تاريخ تسجيل الطلب *</label><input id="requestDate" type="date" name="requestDate" max="${TODAY}" value="${draft.requestDate||TODAY}" required></div><div><label for="requestSubject">موضوع الطلب *</label><input id="requestSubject" name="subject" value="${xSafe(draft.subject)}" required></div></div><div id="dueDatePreview" class="due-preview ${due?'':'hidden'}" aria-live="polite">${due?`الموعد النهائي المتوقع: <strong>${due}</strong>`:''}</div><label for="requestNotes">الملاحظات</label><textarea id="requestNotes" name="notes" rows="4">${xSafe(draft.notes)}</textarea><div class="form-actions"><button class="primary">تسجيل الطلب</button><button type="button" class="secondary-btn" data-nav="dashboard">إلغاء</button></div></form></section>`}
function detailView(d,u,code){let r=d.requests.find(x=>x.reqCode===code);if(!r)return '<div class="alert danger">الطلب غير موجود.</div>';let permitted=baseVisibleRequests(d,u).some(x=>x.id===r.id);if(!permitted)return '<div class="alert danger">غير مصرح بعرض هذا الطلب.</div>';let canClose=r.status==='Open'&&r.userId===u.id,late=calendarLate(r);return `<div class="page-title"><div><div class="kicker">تفاصيل الطلب</div><h1>الطلب رقم ${r.reqCode}</h1></div><span class="status ${r.status==='Closed'?'closed':'open'}">${r.status==='Closed'?'مغلق':'مفتوح'}</span></div><section><div class="details"><div><span>مقدم الطلب</span><b>${r.requesterName}</b></div><div><span>البريد</span><b>${r.officeEmail}</b></div><div><span>القسم</span><b>${r.departmentSnapshot}</b></div><div><span>الخدمة</span><b>${r.serviceCode} - ${r.serviceName}</b></div><div><span>مدة الخدمة</span><b>${r.duration} يوم عمل</b></div><div><span>تاريخ الطلب</span><b>${r.requestDate}</b></div><div><span>الموعد النهائي</span><b>${r.dueDate}</b></div>${r.status==='Open'&&r.dueDate<TODAY?`<div><span>أيام التأخير الحالية</span><b>${currentDelayDays(r,d)}</b></div>`:''}<div><span>الموضوع</span><b>${r.subject}</b></div><div class="wide"><span>الملاحظات</span><b>${r.notes||'-'}</b></div></div></section>${r.status==='Closed'?`<section><h2>بيانات الإغلاق</h2><div class="details"><div><span>تاريخ الإغلاق</span><b>${r.closeDate}</b></div><div><span>وقت تسجيل الإغلاق</span><b>${r.closedAt}</b></div>${late?`<div><span>سبب التأخير</span><b>${r.delayReason||'-'}</b></div>${r.otherDelayReason?`<div><span>السبب الآخر</span><b>${r.otherDelayReason}</b></div>`:''}<div><span>أيام التأخير</span><b>${r.delayDays}</b></div>`:''}<div class="wide"><span>ملاحظات الإغلاق</span><b>${r.closureNotes||'-'}</b></div></div></section>`:canClose?`<section class="form-card"><h2>إغلاق الطلب</h2><form id="closeForm" data-code="${r.reqCode}" data-due="${r.dueDate}"><label>تاريخ إغلاق الطلب *</label><input id="closeDateInput" type="date" name="closeDate" min="${r.requestDate}" max="${TODAY}" value="${TODAY}" required><div id="delayBox" style="display:none"><div class="alert warn top-gap">تاريخ الإغلاق بعد الموعد النهائي؛ يرجى تحديد سبب التأخير.</div><label>سبب التأخير *</label><select id="delayReasonSelect" name="delayReason"><option value="">اختر سبب التأخير</option>${delayReasons.map(x=>`<option>${x}</option>`).join('')}</select><div id="otherReasonBox" style="display:none"><label>السبب الآخر *</label><input id="otherReasonInput" name="otherReason"></div></div><label>ملاحظات الإغلاق</label><textarea name="closureNotes" rows="3"></textarea><button class="primary top-gap">إغلاق الطلب</button></form></section>`:`<div class="alert info">يمكنك عرض هذا الطلب، لكن لا يمكنك إغلاقه. في Phase 1 منشئ الطلب فقط هو من يغلقه.</div>`}`}
function adminFilters(d){let deptFilter=(state.adminTab==='users'||state.adminTab==='services')?`<div><label>القسم</label><select id="adminDept"><option value="all">جميع الأقسام</option>${d.departments.map(x=>`<option value="${x.id}" ${String(state.adminDept)===String(x.id)?'selected':''}>${x.name}</option>`).join('')}</select></div>`:'';let roleFilter=state.adminTab==='users'?`<div><label>الدور</label><select id="adminRole"><option value="all">جميع الأدوار</option><option value="user" ${state.adminRole==='user'?'selected':''}>مستخدم</option><option value="supervisor" ${state.adminRole==='supervisor'?'selected':''}>مشرف قسم</option><option value="power" ${state.adminRole==='power'?'selected':''}>Power User</option></select></div>`:'';let statusFilter=['users','departments','services'].includes(state.adminTab)?`<div><label>الحالة</label><select id="adminStatus"><option value="all">جميع الحالات</option><option value="active" ${state.adminStatus==='active'?'selected':''}>فعال</option><option value="inactive" ${state.adminStatus==='inactive'?'selected':''}>غير فعال</option></select></div>`:'';return `<div class="admin-filters"><div><label>بحث</label><input id="adminSearch" value="${xSafe(state.adminSearch)}" placeholder="بحث في القائمة"></div>${deptFilter}${roleFilter}${statusFilter}</div>`}
function userForm(d,edit){let x=edit||{name:'',email:'',departmentId:d.departments.find(z=>z.active)?.id||1,role:'user',admin:false,active:true,forcePasswordChange:true};return `<div class="admin-form"><h3>${edit?'تعديل مستخدم':'إضافة مستخدم جديد'}</h3><form id="userAdminForm" data-id="${edit?.id||''}"><div class="grid3"><div><label>الاسم *</label><input name="name" value="${xSafe(x.name)}" required></div><div><label>البريد الرسمي *</label><input name="email" type="email" value="${xSafe(x.email)}" required></div><div><label>القسم *</label><select name="departmentId" required>${d.departments.filter(z=>z.active||z.id===x.departmentId).map(z=>`<option value="${z.id}" ${z.id===x.departmentId?'selected':''}>${z.name}</option>`).join('')}</select></div><div><label>الدور *</label><select name="role"><option value="user" ${x.role==='user'?'selected':''}>مستخدم</option><option value="supervisor" ${x.role==='supervisor'?'selected':''}>مشرف قسم</option><option value="power" ${x.role==='power'?'selected':''}>Power User</option></select></div>${edit?'':`<div><label>كلمة المرور المؤقتة *</label><input name="password" value="Temp123" minlength="6" required></div>`}<div class="check-stack"><label><input class="checkbox" type="checkbox" name="admin" ${x.admin?'checked':''}> مدير نظام</label><label><input class="checkbox" type="checkbox" name="active" ${x.active?'checked':''}> حساب فعال</label><label><input class="checkbox" type="checkbox" name="force" ${x.forcePasswordChange?'checked':''}> إجبار تغيير كلمة المرور</label></div></div><div class="form-actions"><button class="primary">حفظ</button><button type="button" class="secondary-btn" id="cancelAdminForm">إلغاء</button></div></form></div>`}
function departmentForm(edit){let x=edit||{name:'',prefix:'',active:true};return `<div class="admin-form"><h3>${edit?'تعديل قسم':'إضافة قسم جديد'}</h3><form id="departmentAdminForm" data-id="${edit?.id||''}"><div class="grid3"><div><label>اسم القسم *</label><input name="name" value="${xSafe(x.name)}" required></div><div><label>بادئة كود الخدمات *</label><input name="prefix" value="${xSafe(x.prefix)}" ${edit?'readonly':''} maxlength="8" required></div><div class="check-stack"><label><input class="checkbox" type="checkbox" name="active" ${x.active?'checked':''}> فعال</label></div></div><div class="form-actions"><button class="primary">حفظ</button><button type="button" class="secondary-btn" id="cancelAdminForm">إلغاء</button></div></form></div>`}
function serviceForm(d,edit){let x=edit||{name:'',departmentId:d.departments.find(z=>z.active)?.id||1,duration:1,active:true};return `<div class="admin-form"><h3>${edit?'تعديل خدمة':'إضافة خدمة جديدة'}</h3><form id="serviceAdminForm" data-id="${edit?.id||''}"><div class="grid3">${edit?`<div><label>الكود</label><input value="${x.code}" readonly></div>`:''}<div><label>الخدمة *</label><input name="name" value="${xSafe(x.name)}" required></div><div><label>القسم *</label><select name="departmentId" ${edit?'disabled':''}>${d.departments.filter(z=>z.active||z.id===x.departmentId).map(z=>`<option value="${z.id}" ${z.id===x.departmentId?'selected':''}>${z.name}</option>`).join('')}</select>${edit?`<input type="hidden" name="departmentId" value="${x.departmentId}">`:''}</div><div><label>مدة الخدمة (يوم عمل) *</label><input name="duration" type="number" min="1" value="${x.duration}" required></div><div class="check-stack"><label><input class="checkbox" type="checkbox" name="active" ${x.active?'checked':''}> فعال</label></div></div><div class="form-actions"><button class="primary">حفظ</button><button type="button" class="secondary-btn" id="cancelAdminForm">إلغاء</button></div></form></div>`}
function holidayForm(edit){let x=edit||{type:'رأس السنة الميلادية',name:'رأس السنة الميلادية',startDate:TODAY,duration:1,active:true};return `<div class="admin-form"><h3>${edit?'تعديل عطلة رسمية':'إضافة عطلة رسمية'}</h3><form id="holidayAdminForm" data-id="${edit?.id||''}"><div class="grid3"><div><label>نوع العطلة *</label><select name="type" id="holidayType">${holidayTypes.map(z=>`<option ${x.type===z?'selected':''}>${z}</option>`).join('')}</select></div><div id="holidayOtherWrap" style="${x.type==='أخرى'?'':'display:none'}"><label>اسم العطلة *</label><input name="name" id="holidayName" value="${xSafe(x.type==='أخرى'?x.name:'')}"></div><div><label>تاريخ البداية *</label><input type="date" name="startDate" id="holidayStart" value="${x.startDate}" required></div><div><label>المدة (أيام تقويمية) *</label><input type="number" name="duration" id="holidayDuration" min="1" value="${x.duration}" required></div><div><label>تاريخ النهاية</label><input id="holidayEndPreview" value="${addCalendarDays(x.startDate,x.duration)}" readonly></div></div><div class="form-actions"><button class="primary">حفظ</button><button type="button" class="secondary-btn" id="cancelAdminForm">إلغاء</button></div></form></div>`}
function adminView(d,u){if(!u.admin)return '<div class="alert danger">غير مصرح.</div>';let rows=adminRows(d),tab=state.adminTab,form='';if(state.adminForm){let obj=state.adminForm.mode==='edit'?({users:d.users,departments:d.departments,services:d.services,holidays:d.holidays}[tab]||[]).find(x=>x.id===state.adminForm.id):null;if(tab==='users')form=userForm(d,obj);if(tab==='departments')form=departmentForm(obj);if(tab==='services')form=serviceForm(d,obj);if(tab==='holidays')form=holidayForm(obj)}let content='';if(tab==='users')content=`<div class="table-wrap"><table id="adminTable"><thead><tr><th>الاسم</th><th>البريد</th><th>القسم</th><th>الدور</th><th>مدير نظام</th><th>الحالة</th><th>طريقة الدخول</th><th>إجبار تغيير كلمة المرور</th><th>الإجراء</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.name}</td><td>${x.email}</td><td>${depName(d,x.departmentId)}</td><td>${roleName(x.role)}</td><td>${x.admin?'نعم':'لا'}</td><td>${x.active?'فعال':'غير فعال'}</td><td>${loginMethod(x)}</td><td>${x.forcePasswordChange?'نعم':'لا'}</td><td class="actions"><button data-edit-admin="${x.id}">تعديل</button><button data-reset-user="${x.id}">تعيين كلمة المرور</button>${x.adPasswordOverride&&!x.isProtected?`<button data-revert-user="${x.id}">إعادة إلى الدليل</button>`:''}<button data-toggle-user="${x.id}">${x.active?'تعطيل':'تفعيل'}</button></td></tr>`).join('')}</tbody></table></div>`;if(tab==='departments')content=`<div class="table-wrap"><table id="adminTable"><thead><tr><th>القسم</th><th>بادئة الخدمات</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.name}</td><td>${x.prefix}</td><td>${x.active?'فعال':'غير فعال'}</td><td class="actions"><button data-edit-admin="${x.id}">تعديل</button><button data-toggle-department="${x.id}">${x.active?'تعطيل':'تفعيل'}</button></td></tr>`).join('')}</tbody></table></div>`;if(tab==='services')content=`<div class="table-wrap"><table id="adminTable"><thead><tr><th>الكود</th><th>الخدمة</th><th>القسم</th><th>المدة</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.code}</td><td>${x.name}</td><td>${depName(d,x.departmentId)}</td><td>${x.duration} يوم</td><td>${x.active?'فعال':'غير فعال'}</td><td class="actions"><button data-edit-admin="${x.id}">تعديل</button><button data-toggle-service="${x.id}">${x.active?'تعطيل':'تفعيل'}</button></td></tr>`).join('')}</tbody></table></div>`;if(tab==='holidays')content=`<div class="table-wrap"><table id="adminTable"><thead><tr><th>العطلة</th><th>النوع</th><th>تاريخ البداية</th><th>المدة</th><th>تاريخ النهاية</th><th>الإجراء</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.name}</td><td>${x.type}</td><td>${x.startDate}</td><td>${x.duration}</td><td>${x.endDate}</td><td class="actions"><button data-edit-admin="${x.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>`;if(tab==='audit')content=`<div class="table-wrap"><table id="adminTable"><thead><tr><th>التاريخ والوقت</th><th>المنفذ</th><th>الإجراء</th><th>الهدف</th><th>القيمة القديمة</th><th>القيمة الجديدة</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${x.timestamp}</td><td>${x.actor}</td><td>${x.action}</td><td>${x.target}</td><td>${x.oldValue||'-'}</td><td>${x.newValue||'-'}</td></tr>`).join('')}</tbody></table></div>`;let canAdd=tab!=='audit';return `<div class="page-title"><div><h1>إدارة النظام</h1><p>إدارة المستخدمين والأقسام والخدمات والعطلات وسجل التدقيق.</p></div><div class="page-actions">${canAdd?`<button class="primary" id="addAdminItem">+ إضافة</button>`:''}<button class="primary export-btn" id="exportAdmin">تصدير إلى Excel</button></div></div><section><div class="tabs"><button data-tab="users" class="${tab==='users'?'active':''}">المستخدمون</button><button data-tab="departments" class="${tab==='departments'?'active':''}">الأقسام</button><button data-tab="services" class="${tab==='services'?'active':''}">الخدمات</button><button data-tab="holidays" class="${tab==='holidays'?'active':''}">العطلات الرسمية</button><button data-tab="audit" class="${tab==='audit'?'active':''}">سجل التدقيق</button></div>${adminFilters(d)}${form}${content}</section><section><h2>أدوات الاختبار</h2><p class="muted">هذه الأداة موجودة في النسخة التجريبية فقط، وستُحذف من نسخة الإنتاج.</p><button class="primary danger-btn" id="resetDemo">إعادة البيانات التجريبية</button></section>`}
function nextCode(d){let yy=String(new Date().getFullYear()).slice(-2),c;do{c=yy+String(Math.floor(Math.random()*1000000)).padStart(6,'0')}while(d.requests.some(r=>r.reqCode===c));return c}
function nextServiceCode(d,departmentId){let dep=d.departments.find(x=>x.id===Number(departmentId)),prefix=dep?.prefix||'SRV',nums=d.services.filter(s=>s.departmentId===Number(departmentId)&&s.code.startsWith(prefix+'-')).map(s=>Number(s.code.split('-').pop())).filter(Number.isFinite),n=(nums.length?Math.max(...nums):0)+1;return `${prefix}-${String(n).padStart(3,'0')}`}
function enhanceRenderedUi(d){document.querySelectorAll('label:not([for])').forEach((label,i)=>{let control=label.querySelector('input,select,textarea')||label.nextElementSibling;if(control&&/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)){if(!control.id)control.id=`field-${state.view}-${i}`;label.htmlFor=control.id}});let reset=document.getElementById('resetDemo');if(reset)reset.closest('section')?.remove();if(state.view==='detail'){let r=d.requests.find(x=>x.reqCode===state.reqCode),title=document.querySelector('.page-title');if(title){let actions=title.querySelector('.page-actions')||document.createElement('div');actions.className='page-actions';if(!actions.parentNode)title.appendChild(actions);let back=document.createElement('button');back.type='button';back.className='secondary-btn';back.dataset.nav='dashboard';back.textContent='العودة إلى الطلبات';actions.prepend(back)}if(r?.status==='Open'&&r.dueDate<TODAY){let badge=title?.querySelector('.status');if(badge){badge.className='status late';badge.textContent='مفتوح ومتأخر'}}}}
function render(){let d=load(),u=user(),root=document.getElementById('app'),active=document.activeElement,focusId=active?.id,selection=typeof active?.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
 // Not signed in, or the snapshot has not arrived yet: the login screen is the
 // only thing that can be drawn without data.
 if(!u||!d){root.innerHTML=loginView();bindLogin();return}
 if(u.forcePasswordChange){root.innerHTML=forcePasswordView();bindForcePassword();return}let body=state.view==='dashboard'?dashboard(d,u):state.view==='new'?newView(d,u):state.view==='detail'?detailView(d,u,state.reqCode):state.view==='admin'?adminView(d,u):dashboard(d,u);root.innerHTML=shell(body,d,u);enhanceRenderedUi(d);bindCommon(d,u);if(focusId){let next=document.getElementById(focusId);if(next){next.focus();if(selection&&next.setSelectionRange)next.setSelectionRange(...selection)}}state.flash=null}
function bindLogin(){
 // The prototype searched a list of users in the browser and compared the
 // password in plain text. Both now happen on the server: against a bcrypt hash
 // for a local account, or against Active Directory for everyone else. The
 // browser never sees a password other than the one being typed.
 const form=document.getElementById('loginForm');if(!form)return;
 const err=m=>{document.getElementById('loginErr').innerHTML=`<div class="alert danger">${m}</div>`};
 form.onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  const identifier=String(f.get('email')||'').trim(),password=String(f.get('password')||'');
  const btn=form.querySelector('button');if(btn){btn.disabled=true;btn.textContent='جارٍ التحقق...'}
  try{
   await API.login(identifier,password);
   await refresh();
   resetDashboardFilters();
   state.view='dashboard';state.reqCode=null;state.flash=null;
   history.replaceState({iso:true,view:'dashboard',reqCode:null},'','#dashboard');
   render();
  }catch(ex){
   err(ex.message||'تعذّر تسجيل الدخول.');
   if(btn){btn.disabled=false;btn.textContent='تسجيل الدخول'}
  }
 }}
function bindForcePassword(){
 // A temporary password is refused for every other endpoint until this succeeds
 // — the server enforces that, not just this screen.
 const form=document.getElementById('forcePasswordForm');if(!form)return;
 const err=m=>{document.getElementById('forceErr').innerHTML=`<div class="alert danger">${m}</div>`};
 form.onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(e.target);
  try{
   await API.changePassword(f.get('password'),f.get('confirmPassword'));
   await refresh();
   state.flash={type:'success',text:'تم تغيير كلمة المرور.'};
   state.view='dashboard';
   render();
  }catch(ex){err(ex.message||'تعذّر تغيير كلمة المرور.')}
 }}
function setAndRender(k,v){state[k]=v;render()}
function bindCommon(d,u){document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{state.view=b.dataset.nav;state.reqCode=null;render()});let rf=document.getElementById('refreshData');if(rf)rf.onclick=async()=>{
  // The snapshot is fetched once at sign-in. Anything an administrator changes
  // afterwards — importing staff, moving someone's department, adding a service —
  // is invisible to a page already open until it asks again. This is that ask.
  rf.disabled=true;const was=rf.textContent;rf.textContent='...جارٍ التحديث';
  try{await refresh();state.flash={type:'success',text:'تم تحديث البيانات.'}}
  catch(e){state.flash={type:'danger',text:e.message||'تعذّر التحديث.'}}
  rf.disabled=false;rf.textContent=was;render();
 };
 let lo=document.getElementById('logout');if(lo)lo.onclick=async()=>{
  // Deleting the session row server-side is what actually ends it; clearing the
  // token here alone would leave a working token behind.
  await API.logout();DATA=null;ME=null;resetDashboardFilters();state.view='dashboard';render()};document.querySelectorAll('[data-open]').forEach(x=>x.onclick=()=>{state.view='detail';state.reqCode=x.dataset.open;render()});
 let dd=document.getElementById('dashDepartment');if(dd&&!dd.disabled)dd.onchange=e=>{state.dashDepartment=e.target.value;state.dashEmployee='all';state.dashService='all';render()};let de=document.getElementById('dashEmployee');if(de&&!de.disabled)de.onchange=e=>{state.dashEmployee=e.target.value;render()};let ds=document.getElementById('dashService');if(ds)ds.onchange=e=>{state.dashService=e.target.value;render()};let dst=document.getElementById('dashStatus');if(dst)dst.onchange=e=>{state.dashStatus=e.target.value;render()};let dfrom=document.getElementById('dashDateFrom');if(dfrom)dfrom.onchange=e=>{state.dashDateFrom=e.target.value;render()};let dto=document.getElementById('dashDateTo');if(dto)dto.onchange=e=>{state.dashDateTo=e.target.value;render()};
 let dr=document.getElementById('dashReqCode'),dq=document.getElementById('dashSearch');let captureText=()=>{if(dr)state.dashReqCode=dr.value;if(dq)state.search=dq.value};if(dr){dr.oninput=captureText;dr.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();captureText();render()}}}if(dq){dq.oninput=captureText;dq.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();captureText();render()}}}let apply=document.getElementById('applyDashboardFilters');if(apply)apply.onclick=()=>{captureText();render()};let clear=document.getElementById('clearDashboardFilters');if(clear)clear.onclick=()=>{resetDashboardFilters();render()};let more=document.getElementById('showMoreRequests');if(more)more.onclick=()=>{state.dashLimit+=DASH_PAGE;render()};document.querySelectorAll('[data-card-filter]').forEach(c=>c.onclick=()=>{state.dashStatus=c.dataset.cardFilter;render()});
 let er=document.getElementById('exportRequests');if(er)er.onclick=()=>{captureText();exportRequestsXlsx(d,u)};let ea=document.getElementById('exportAdmin');if(ea)ea.onclick=()=>exportAdminXlsx(d);
 let nf=document.getElementById('newForm');if(nf){let captureDraft=()=>{let f=new FormData(nf);state.newDraft={serviceId:String(f.get('serviceId')||''),requestDate:String(f.get('requestDate')||TODAY),subject:String(f.get('subject')||''),notes:String(f.get('notes')||'')}};let updateDue=()=>{captureDraft();let service=d.services.find(s=>String(s.id)===state.newDraft.serviceId),preview=document.getElementById('dueDatePreview');if(!preview)return;if(service&&state.newDraft.requestDate){preview.innerHTML=`الموعد النهائي المتوقع: <strong>${addWork(state.newDraft.requestDate,service.duration,d)}</strong>`;preview.classList.remove('hidden')}else{preview.textContent='';preview.classList.add('hidden')}};nf.querySelectorAll('input,select,textarea').forEach(x=>x.addEventListener('input',captureDraft));nf.querySelector('[name="serviceId"]')?.addEventListener('change',updateDue);nf.querySelector('[name="requestDate"]')?.addEventListener('change',updateDue);nf.onsubmit=async e=>{
  e.preventDefault();
  // Validation still runs here so the user gets an immediate answer, but it is
  // a courtesy: the server checks the same things again — that the service is
  // active, that it belongs to the caller's own department, and that the date is
  // not in the future — and it computes the deadline itself.
  const f=new FormData(nf),serviceId=Number(f.get('serviceId')),requestDate=f.get('requestDate'),subject=String(f.get('subject')||'').trim();
  if(!serviceId||!subject||!requestDate||requestDate>TODAY){
   state.flash={type:'danger',text:'يرجى التأكد من الحقول المطلوبة وأن تاريخ الطلب ليس في المستقبل.'};render();return}
  const created=await mutate(()=>API.createRequest({serviceId,requestDate,subject,notes:String(f.get('notes')||'').trim()}),
   r=>`تم تسجيل الطلب بنجاح. رقم الطلب: ${r.request.reqCode}`);
  if(created){state.newDraft={serviceId:'',requestDate:TODAY,subject:'',notes:''};state.view='detail';state.reqCode=created.request.reqCode;render()}
 }}
 let cf=document.getElementById('closeForm');if(cf){
  // The delay panel appears as soon as the chosen date passes the deadline. The
  // server applies the same rule when it saves: a late closure without a reason
  // is refused there too, because the delay analysis counts requests by reason
  // and a blank one cannot be counted.
  let closeInput=document.getElementById('closeDateInput'),delayBox=document.getElementById('delayBox'),
      delaySelect=document.getElementById('delayReasonSelect'),otherBox=document.getElementById('otherReasonBox'),
      otherInput=document.getElementById('otherReasonInput'),due=cf.dataset.due;
  let syncDelay=()=>{let late=closeInput.value>due;delayBox.style.display=late?'block':'none';delaySelect.required=late;
   if(!late){delaySelect.value='';otherInput.value='';otherBox.style.display='none';otherInput.required=false}
   else{let isOther=delaySelect.value==='أسباب أخرى';otherBox.style.display=isOther?'block':'none';otherInput.required=isOther;if(!isOther)otherInput.value=''}};
  closeInput.onchange=syncDelay;closeInput.oninput=syncDelay;delaySelect.onchange=syncDelay;syncDelay();
  cf.onsubmit=async e=>{
   e.preventDefault();
   const code=cf.dataset.code,f=new FormData(cf),closeDate=f.get('closeDate');
   const late=closeDate>due,reason=f.get('delayReason')||'',other=String(f.get('otherReason')||'').trim();
   if(late&&!reason){state.flash={type:'danger',text:'سبب التأخير مطلوب لأن تاريخ الإغلاق بعد الموعد النهائي.'};render();return}
   if(late&&reason==='أسباب أخرى'&&!other){state.flash={type:'danger',text:'يرجى كتابة السبب الآخر للتأخير.'};render();return}
   if(!confirm(`هل أنت متأكد من إغلاق الطلب رقم ${code}؟`))return;
   await mutate(()=>API.closeRequest(code,{closeDate,delayReason:reason,otherDelayReason:other,closureNotes:String(f.get('closureNotes')||'').trim()}),
    `تم إغلاق الطلب رقم ${code} بنجاح.`);
  }};
 bindAdmin(d,u)}
/** Loads سجل التدقيق on demand.
 *
 *  Deliberately not part of the startup snapshot: the audit table only ever
 *  grows, and shipping a year of it to every sign-in — including to the people
 *  who are not allowed to read it — would be both slow and wrong. It is fetched
 *  when the tab is opened, and only مدير النظام can fetch it at all. */
async function loadAudit(){
 try{
  const r=await API.audit(state.adminSearch||'');
  DATA.audits=r.entries;
 }catch(e){
  DATA.audits=[];
  state.flash={type:'danger',text:e.message};
 }
 render();
}

function bindAdmin(d,u){document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.adminTab=b.dataset.tab;state.adminForm=null;state.adminSearch='';state.adminDept=state.adminRole=state.adminStatus='all';if(state.adminTab==='audit'){DATA.audits=[];render();loadAudit();return}render()});let as=document.getElementById('adminSearch');if(as)as.oninput=e=>{state.adminSearch=e.target.value;render()};let ad=document.getElementById('adminDept');if(ad)ad.onchange=e=>setAndRender('adminDept',e.target.value);let ar=document.getElementById('adminRole');if(ar)ar.onchange=e=>setAndRender('adminRole',e.target.value);let ast=document.getElementById('adminStatus');if(ast)ast.onchange=e=>setAndRender('adminStatus',e.target.value);let add=document.getElementById('addAdminItem');if(add)add.onclick=()=>{state.adminForm={mode:'add'};render()};document.querySelectorAll('[data-edit-admin]').forEach(b=>b.onclick=()=>{state.adminForm={mode:'edit',id:Number(b.dataset.editAdmin)};render()});let cancel=document.getElementById('cancelAdminForm');if(cancel)cancel.onclick=()=>{state.adminForm=null;render()};
 let uf=document.getElementById('userAdminForm');if(uf)uf.onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(uf),id=Number(uf.dataset.id||0);
  const payload={name:String(f.get('name')).trim(),email:String(f.get('email')).trim().toLowerCase(),
   departmentId:Number(f.get('departmentId')),role:f.get('role'),
   admin:f.get('admin')==='on',active:f.get('active')==='on',forcePasswordChange:f.get('force')==='on'};
  // The readable "before → after" audit entry is built server-side now, over the
  // row as it actually was. Building it here meant auditing what the browser
  // believed, which is not the same thing once two people edit at once.
  if(id) await mutate(()=>API.updateUser(id,payload),'تم حفظ التعديلات.',closeAdminForm);
  else   await mutate(()=>API.createUser({...payload,password:f.get('password')}),'تم إنشاء الحساب.',closeAdminForm);
 };
 document.querySelectorAll('[data-toggle-user]').forEach(b=>b.onclick=()=>
  mutate(()=>API.toggleUser(Number(b.dataset.toggleUser)),r=>r.user.active?'تم تفعيل الحساب.':'تم تعطيل الحساب. وأُنهيت جلساته المفتوحة.'));
 // تعيين كلمة المرور — مدير النظام only, and the only way a password changes in
 // this system now. Two cases get a confirmation before the prompt, because both
 // do something the administrator may not have intended from a row in a table:
 //
 //  • an Active Directory account: writing a password here moves the account
 //    onto local sign-in, and the directory password stops opening THIS system.
 //  • his own account: the reset ends every session, including the one he is
 //    using, so he is signed out and comes back through the forced-change screen.
 document.querySelectorAll('[data-reset-user]').forEach(b=>b.onclick=()=>{
  const id=Number(b.dataset.resetUser);
  const x=(load().users||[]).find(z=>z.id===id);
  const who=x?x.name:'';
  if(x&&x.isLdap&&!confirm(`${who} يسجّل الدخول حالياً عبر Active Directory.\n\nتعيين كلمة مرور من هنا يجعل هذا الحساب يستخدم كلمة المرور المحلية للدخول إلى هذا النظام، ولن تعمل كلمة مرور الدليل هنا بعد ذلك.\n\n(كلمة مرور الحساب في Active Directory نفسها لن تتغير، وستظل تعمل في الأنظمة الأخرى.)\n\nهل تريد المتابعة؟`))return;
  if(x&&ME&&x.id===ME.id&&!confirm('هذه كلمة مرور حسابك. ستُنهى جلستك الحالية وسيُطلب منك الدخول بكلمة المرور الجديدة وتغييرها. هل تريد المتابعة؟'))return;
  const pw=prompt(`أدخل كلمة مرور مؤقتة جديدة للمستخدم ${who}:`,'Temp123');
  if(!pw)return;
  if(pw.length<6){alert('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');return}
  // The server composes the message: it is the side that knows whether this row
  // was an AD account a moment ago, and says so in the confirmation.
  mutate(()=>API.resetUserPassword(id,pw),r=>r.message||'تم تعيين كلمة المرور وسيُطلب من المستخدم تغييرها عند الدخول.');
 });
 // إعادة إلى الدليل — undoes an override. Only rendered for a row that has one,
 // so there is no "revert" offered on an account that never came from AD, where
 // deleting the local password would lock it out for good. The server refuses
 // that case too, and refuses when no directory is configured.
 document.querySelectorAll('[data-revert-user]').forEach(b=>b.onclick=()=>{
  const id=Number(b.dataset.revertUser);
  const x=(load().users||[]).find(z=>z.id===id);
  const who=x?x.name:'';
  if(!confirm(`إعادة ${who} إلى الدخول عبر Active Directory.\n\nستُحذف كلمة المرور المحلية لهذا الحساب، وسيسجّل الدخول بكلمة مروره في الدليل، وستُنهى جلساته المفتوحة.\n\nهل تريد المتابعة؟`))return;
  if(x&&ME&&x.id===ME.id&&!confirm('هذا حسابك. ستُنهى جلستك الحالية وستحتاج إلى الدخول بكلمة مرورك في Active Directory. هل تريد المتابعة؟'))return;
  mutate(()=>API.revertUserToDirectory(id),r=>r.message||'تم إلغاء كلمة المرور المحلية.');
 });
 let df=document.getElementById('departmentAdminForm');if(df)df.onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(df),id=Number(df.dataset.id||0);
  const name=String(f.get('name')).trim(),active=f.get('active')==='on';
  // The prefix is sent only when creating. It is what existing service codes
  // were minted from, so the server refuses to change it on an edit rather than
  // orphaning every code already printed on paperwork.
  const prefix=String(f.get('prefix')).trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(id) await mutate(()=>API.updateDepartment(id,{name,active}),'تم حفظ القسم.',closeAdminForm);
  else   await mutate(()=>API.createDepartment({name,prefix,active}),'تم إنشاء القسم.',closeAdminForm);
 };
 document.querySelectorAll('[data-toggle-department]').forEach(b=>b.onclick=()=>
  mutate(()=>API.toggleDepartment(Number(b.dataset.toggleDepartment)),r=>r.department.active?'تم تفعيل القسم.':'تم تعطيل القسم.'));
 let sf=document.getElementById('serviceAdminForm');if(sf)sf.onsubmit=async e=>{
  e.preventDefault();
  const f=new FormData(sf),id=Number(sf.dataset.id||0);
  const name=String(f.get('name')).trim(),duration=Number(f.get('duration')),active=f.get('active')==='on';
  // The service code is generated by the server from the department's prefix —
  // it is never typed, because a hand-entered code stops being unique.
  if(id) await mutate(()=>API.updateService(id,{name,duration,active}),r=>r.note||'تم حفظ الخدمة.',closeAdminForm);
  else   await mutate(()=>API.createService({departmentId:Number(f.get('departmentId')),name,duration,active}),
          r=>`تم إنشاء الخدمة بالكود ${r.service.code}.`,closeAdminForm);
 };
 document.querySelectorAll('[data-toggle-service]').forEach(b=>b.onclick=()=>
  mutate(()=>API.toggleService(Number(b.dataset.toggleService)),r=>r.service.active?'تم تفعيل الخدمة.':'تم تعطيل الخدمة.'));
 let hf=document.getElementById('holidayAdminForm');if(hf){
  let type=document.getElementById('holidayType'),other=document.getElementById('holidayOtherWrap'),
      start=document.getElementById('holidayStart'),dur=document.getElementById('holidayDuration'),
      preview=document.getElementById('holidayEndPreview');
  // The end date preview is calendar days — عيد الفطر is four days whether or
  // not a weekend falls inside it — and the server computes the stored value
  // the same way.
  let sync=()=>{other.style.display=type.value==='أخرى'?'block':'none';preview.value=addCalendarDays(start.value||TODAY,Number(dur.value||1))};
  type.onchange=sync;start.oninput=sync;dur.oninput=sync;sync();
  hf.onsubmit=async e=>{
   e.preventDefault();
   const f=new FormData(hf),id=Number(hf.dataset.id||0),ht=f.get('type');
   const payload={type:ht,name:ht==='أخرى'?String(f.get('name')||'').trim():ht,
    startDate:f.get('startDate'),duration:Number(f.get('duration'))};
   if(!payload.name){alert('اسم العطلة مطلوب.');return}
   // Declaring a holiday moves the deadline of everything still open, and the
   // server reports how many it moved — worth telling the administrator, since
   // one click can change dozens of dates.
   const msg=r=>r.movedDeadlines?`تم الحفظ. أُعيد احتساب ${r.movedDeadlines} موعداً نهائياً للطلبات المفتوحة.`:'تم الحفظ.';
   if(id) await mutate(()=>API.updateHoliday(id,payload),msg,closeAdminForm);
   else   await mutate(()=>API.createHoliday(payload),msg,closeAdminForm);
  }};
 document.querySelectorAll('[data-delete-holiday]').forEach(b=>b.onclick=()=>{
  if(!confirm('هل أنت متأكد من حذف هذه العطلة؟ سيُعاد احتساب المواعيد النهائية للطلبات المفتوحة.'))return;
  mutate(()=>API.deleteHoliday(Number(b.dataset.deleteHoliday)),
   r=>r.movedDeadlines?`تم حذف العطلة. أُعيد احتساب ${r.movedDeadlines} موعداً نهائياً.`:'تم حذف العطلة.');
 });
 let reset=document.getElementById('resetDemo');if(reset)reset.onclick=()=>{
  // The prototype cleared localStorage, which only ever affected the one browser
  // that clicked it. The data now lives in a database shared by everyone, so a
  // button that wipes it does not belong in the UI at all — it is a deliberate
  // command run on the server.
  alert('لم تعد البيانات مخزّنة في المتصفح، بل في قاعدة بيانات الخادم.\n\nلإعادة التهيئة، يُنفَّذ على الخادم:\n    npm run seed -- --reset');
 };
}

// ── Boot ──────────────────────────────────────────────────────
//
// The prototype could render immediately: its data was already in localStorage.
// The snapshot now has to be fetched, so the first paint is the login screen
// and the app draws once the server has answered.
//
// A 401 at any point — the session expired, an administrator deactivated the
// account, someone forced a sign-out — drops straight back to the login screen
// with the server's own message, rather than leaving a page that silently stops
// updating and looks like the data has gone.
API.onSessionLost((message) => {
  DATA = null; ME = null;
  state = { ...state, view: 'dashboard', reqCode: null, adminForm: null };
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = loginView();
    bindLogin();
    const err = document.getElementById('loginErr');
    if (err && message) err.innerHTML = `<div class="alert warn">${message}</div>`;
  }
});

// Re-fetch when the tab comes back to the front, if the snapshot is more than a
// minute old.
//
// The data is loaded once at sign-in, so a page left open shows whatever was
// true when it was opened — and an administrator who imports a hundred staff
// then looks at a tab from before sees none of them, which looks exactly like
// the import having failed. It cost real time to diagnose three times over.
//
// Tied to focus rather than a timer: a page nobody is looking at does not need
// to be correct, and polling every open tab all day to fix a rare staleness is
// the wrong trade. The one-minute floor stops a burst of alt-tabbing from
// firing a request each time.
document.addEventListener('input',e=>{if(e.target?.id!=='adminSearch')return;e.stopImmediatePropagation();state.adminSearch=e.target.value;clearTimeout(adminSearchTimer);adminSearchTimer=setTimeout(()=>render(),250)},true);
document.addEventListener('click',e=>{let nav=e.target.closest?.('[data-nav]'),open=e.target.closest?.('[data-open]');if(!nav&&!open)return;if(!history.state?.iso)history.replaceState({iso:true,view:state.view,reqCode:state.reqCode},'',`#${state.view}${state.reqCode?`/${state.reqCode}`:''}`);let view=open?'detail':nav.dataset.nav,reqCode=open?open.dataset.open:null;history.pushState({iso:true,view,reqCode},'',`#${view}${reqCode?`/${reqCode}`:''}`)},true);
window.addEventListener('popstate',e=>{if(!e.state?.iso)return;state.view=e.state.view||'dashboard';state.reqCode=e.state.reqCode||null;render()});
function applyRouteFromLocation(){let [view,reqCode]=location.hash.replace(/^#/,'').split('/');if(!['dashboard','new','detail','admin'].includes(view))view='dashboard';state.view=view;state.reqCode=view==='detail'&&reqCode?reqCode:null;history.replaceState({iso:true,view:state.view,reqCode:state.reqCode},'',`#${state.view}${state.reqCode?`/${state.reqCode}`:''}`)}

let lastRefreshAt = 0;
const REFRESH_AFTER_MS = 60 * 1000;

document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !API.isSignedIn() || !DATA) return;
  if (Date.now() - lastRefreshAt < REFRESH_AFTER_MS) return;
  try {
    await refresh();
    lastRefreshAt = Date.now();
    render();
  } catch {
    // A failed background refresh is not worth interrupting anyone over. The
    // page keeps working on what it already has; a 401 is handled by
    // onSessionLost, which is the only case that actually matters.
  }
});

(async () => {
  // A token from a previous page load in this tab. Trying it means a refresh
  // does not ask for the password again; if it has been revoked, onSessionLost
  // above puts the login screen up.
  if (API.isSignedIn()) {
    try { await refresh(); lastRefreshAt = Date.now(); }
    catch { /* onSessionLost has already handled it */ }
    if (DATA && ME) applyRouteFromLocation();
  }
  render();
})();
