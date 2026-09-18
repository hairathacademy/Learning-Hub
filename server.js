require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const db = new Database(process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(__dirname,'course.db'));
db.pragma('journal_mode = WAL');

// Database schema + a small migration so empty student emails can be used repeatedly.
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  access_level TEXT NOT NULL DEFAULT 'PREVIEW',
  account_status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS lesson_progress(
  user_id INTEGER NOT NULL,
  course_name TEXT NOT NULL,
  video_index INTEGER NOT NULL,
  watched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, course_name, video_index),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

// Migrate the original NOT NULL email schema to a nullable unique email column.
const emailInfo = db.prepare("PRAGMA table_info(users)").all().find(c => c.name === 'email');
if (emailInfo && emailInfo.notnull === 1) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasCreated = columns.some(c => c.name === 'created_at');
  db.transaction(() => {
    db.exec(`CREATE TABLE users_new(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      access_level TEXT NOT NULL DEFAULT 'PREVIEW',
      account_status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec(`INSERT INTO users_new(id,username,email,password_hash,role,payment_status,access_level,account_status,created_at)
      SELECT id,username,NULLIF(email,''),password_hash,role,payment_status,access_level,account_status,${hasCreated ? 'created_at' : 'CURRENT_TIMESTAMP'} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  })();
}

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMeNow!2026';
const adminManagePassword = process.env.ADMIN_MANAGE_PASSWORD || '3833';
const seed = db.prepare('SELECT id FROM users WHERE username=?').get(adminUsername);
if (!seed) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  db.prepare('INSERT INTO users(username,email,password_hash,role,payment_status,access_level,account_status) VALUES(?,?,?,?,?,?,?)')
    .run(adminUsername, adminEmail, hash, 'admin', 'PAID', 'FULL_COURSE', 'ACTIVE');
}

db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('whatsapp_number',?)")
  .run(process.env.WHATSAPP_NUMBER || '94777122951');
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('academy_name',?)").run('HAIRATH ACADEMY');
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('academy_tagline',?)").run('RESEARCH AND EDUCATION DEVELOPMENT');
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('facebook_url',?)").run('https://www.facebook.com/HairathAcademy/');
const coursesFile = path.join(__dirname,'data','courses.json');
function readSeedCourses(){
  try { return fs.existsSync(coursesFile) ? JSON.parse(fs.readFileSync(coursesFile,'utf8')) : []; }
  catch { return []; }
}
function getCourses(){
  const row=db.prepare("SELECT value FROM settings WHERE key='courses_json'").get();
  try{
    const parsed=row ? JSON.parse(row.value) : [];
    if(Array.isArray(parsed) && parsed.length) return parsed;
  }catch{}
  const seedCourses=readSeedCourses();
  if(seedCourses.length) {
    db.prepare("INSERT INTO settings(key,value) VALUES('courses_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(seedCourses));
  }
  return seedCourses;
}
function saveCourses(courses){
  db.prepare("INSERT INTO settings(key,value) VALUES('courses_json',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(courses));
}
function getSetting(key, fallback=''){return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;}

app.use(express.json({limit:'5mb'}));

// Lightweight CORS support so the app can still reach the local API if a browser
// accidentally opens the HTML from a file:// origin. Same-origin requests are unaffected.
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin){
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Credentials','true');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  }
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:1000*60*60*24*7 }
}));
app.use(express.static(path.join(__dirname,'public')));

function safe(u){
  return {id:u.id,username:u.username,email:u.email||'',role:u.role,payment_status:u.payment_status,access_level:u.access_level,account_status:u.account_status,created_at:u.created_at};
}
function currentUser(req){ return req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; }
function admin(req,res,next){
  const u=currentUser(req);
  if(!u || u.role!=='admin' || u.account_status!=='ACTIVE') return res.status(403).json({error:'Admin access required'});
  next();
}
function adminManage(req,res,next){
  const u=currentUser(req);
  if(!u || u.role!=='admin' || u.account_status!=='ACTIVE') return res.status(403).json({error:'Admin access required'});
  const supplied=String(req.body?.manage_password||'');
  if(supplied!==adminManagePassword) return res.status(403).json({error:'Management password is incorrect.'});
  next();
}

app.post('/api/admin/verify-management',admin,(req,res)=>{
  const supplied=String(req.body?.manage_password||'');
  if(supplied!==adminManagePassword) return res.status(403).json({error:'Management password is incorrect.'});
  res.json({ok:true});
});

app.get('/api/health',(req,res)=>res.json({ok:true,service:'hairath-academy-course-platform'}));

app.get('/api/config',(req,res)=>res.json({whatsapp_number:getSetting('whatsapp_number'),academy_name:getSetting('academy_name','HAIRATH ACADEMY'),academy_tagline:getSetting('academy_tagline','RESEARCH AND EDUCATION DEVELOPMENT'),facebook_url:getSetting('facebook_url','https://www.facebook.com/HairathAcademy/')}));
app.get('/api/courses',(req,res)=>res.json({courses:getCourses()}));
app.get('/api/me',(req,res)=>res.json({user:currentUser(req)?safe(currentUser(req)):null}));

app.post('/api/login',(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const password=String(req.body?.password||'');
  const u=db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username,username);
  if(!u || u.account_status!=='ACTIVE' || !bcrypt.compareSync(password,u.password_hash))
    return res.status(401).json({error:'Invalid username/email or password.'});
  req.session.userId=u.id;
  const hist=db.prepare('INSERT INTO login_history(user_id,username,role) VALUES(?,?,?)').run(u.id,u.username,u.role);
  req.session.loginHistoryId=hist.lastInsertRowid;
  res.json({user:safe(u)});
});
app.post('/api/logout',(req,res)=>{
  const hid=req.session.loginHistoryId;
  if(hid) db.prepare('UPDATE login_history SET logout_at=CURRENT_TIMESTAMP WHERE id=? AND logout_at IS NULL').run(hid);
  req.session.destroy(()=>res.json({ok:true}));
});

// All student records, not just one row.
app.get('/api/admin/students',admin,(req,res)=>{
  const students=db.prepare("SELECT id,username,email,payment_status,access_level,account_status,created_at FROM users WHERE role='student' ORDER BY id DESC").all();
  res.json({students});
});

app.post('/api/admin/students',admin,(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const email=String(req.body?.email||'').trim() || null;
  const password=String(req.body?.password||'');
  const payment_status=req.body?.payment_status||'PAID';
  const access_level=req.body?.access_level||'FULL_COURSE';
  const account_status=req.body?.account_status||'ACTIVE';
  if(!username || !password) return res.status(400).json({error:'Username and password are required.'});
  if(!/^[A-Za-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({error:'Username must be 3-50 characters (letters, numbers, dot, underscore or hyphen).'});
  if(password.length<4) return res.status(400).json({error:'Password must contain at least 4 characters.'});
  if(!['PAID','UNPAID'].includes(payment_status)||!['FULL_COURSE','PREVIEW'].includes(access_level)||!['ACTIVE','SUSPENDED'].includes(account_status)) return res.status(400).json({error:'Invalid account values.'});
  try{
    const hash=bcrypt.hashSync(password,12);
    const r=db.prepare('INSERT INTO users(username,email,password_hash,role,payment_status,access_level,account_status) VALUES(?,?,?,?,?,?,?)')
      .run(username,email,hash,'student',payment_status,access_level,account_status);
    const student=db.prepare('SELECT id,username,email,payment_status,access_level,account_status,created_at FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({student});
  }catch(e){ res.status(409).json({error:'Username or email already exists.'}); }
});

app.put('/api/admin/students/:id',admin,(req,res)=>{
  const id=Number(req.params.id);
  const existing=db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(id);
  if(!existing) return res.status(404).json({error:'Student not found.'});
  const username=String(req.body?.username ?? existing.username).trim();
  const email=String(req.body?.email ?? existing.email ?? '').trim() || null;
  const payment_status=req.body?.payment_status ?? existing.payment_status;
  const access_level=req.body?.access_level ?? existing.access_level;
  const account_status=req.body?.account_status ?? existing.account_status;
  const newPassword=String(req.body?.password||'');
  if(!username) return res.status(400).json({error:'Username is required.'});
  if(!['PAID','UNPAID'].includes(payment_status)||!['FULL_COURSE','PREVIEW'].includes(access_level)||!['ACTIVE','SUSPENDED'].includes(account_status)) return res.status(400).json({error:'Invalid account values.'});
  try{
    if(newPassword){
      if(newPassword.length<4) return res.status(400).json({error:'Password must contain at least 4 characters.'});
      const hash=bcrypt.hashSync(newPassword,12);
      db.prepare('UPDATE users SET username=?,email=?,password_hash=?,payment_status=?,access_level=?,account_status=? WHERE id=?')
        .run(username,email,hash,payment_status,access_level,account_status,id);
    } else {
      db.prepare('UPDATE users SET username=?,email=?,payment_status=?,access_level=?,account_status=? WHERE id=?')
        .run(username,email,payment_status,access_level,account_status,id);
    }
    res.json({student:db.prepare('SELECT id,username,email,payment_status,access_level,account_status,created_at FROM users WHERE id=?').get(id)});
  }catch(e){ res.status(409).json({error:'Username or email already exists.'}); }
});

app.get('/api/admin/login-history',admin,(req,res)=>{
  const rows=db.prepare(`SELECT id,username,role,login_at,logout_at FROM login_history ORDER BY id DESC LIMIT 500`).all();
  res.json({history:rows});
});

app.get('/api/admin/student-progress/:id',admin,(req,res)=>{
  const id=Number(req.params.id);
  const student=db.prepare("SELECT id,username,email FROM users WHERE id=? AND role='student'").get(id);
  if(!student) return res.status(404).json({error:'Student not found.'});
  const rows=db.prepare('SELECT course_name,video_index,watched_at FROM lesson_progress WHERE user_id=? ORDER BY course_name,video_index').all(id);
  res.json({student,progress:rows});
});

app.get('/api/student/progress', (req,res)=>{
  const u=currentUser(req);
  if(!u || u.role==='admin' || u.account_status!=='ACTIVE') return res.status(403).json({error:'Student access required'});
  const rows=db.prepare('SELECT course_name,video_index,watched_at FROM lesson_progress WHERE user_id=? ORDER BY course_name,video_index').all(u.id);
  res.json({progress:rows});
});

app.post('/api/student/progress', (req,res)=>{
  const u=currentUser(req);
  if(!u || u.role==='admin' || u.account_status!=='ACTIVE') return res.status(403).json({error:'Student access required'});
  const course=String(req.body?.course_name||'').trim();
  const index=Number(req.body?.video_index);
  if(!course || !Number.isInteger(index) || index<0) return res.status(400).json({error:'Invalid lesson progress.'});
  db.prepare('INSERT INTO lesson_progress(user_id,course_name,video_index) VALUES(?,?,?) ON CONFLICT(user_id,course_name,video_index) DO UPDATE SET watched_at=CURRENT_TIMESTAMP').run(u.id,course,index);
  res.json({ok:true});
});


app.get('/api/admin/admins',admin,(req,res)=>{
  const admins=db.prepare("SELECT id,username,email,account_status,created_at FROM users WHERE role='admin' ORDER BY id ASC").all();
  res.json({admins});
});

app.post('/api/admin/admins',admin,(req,res)=>{
  const username=String(req.body?.username||'').trim();
  const email=String(req.body?.email||'').trim()||null;
  const password=String(req.body?.password||'');
  if(!username||!password) return res.status(400).json({error:'Admin username and password are required.'});
  if(!/^[A-Za-z0-9._-]{3,50}$/.test(username)) return res.status(400).json({error:'Username must be 3-50 characters (letters, numbers, dot, underscore or hyphen).'});
  if(password.length<4) return res.status(400).json({error:'Password must contain at least 4 characters.'});
  try{
    const hash=bcrypt.hashSync(password,12);
    const r=db.prepare('INSERT INTO users(username,email,password_hash,role,payment_status,access_level,account_status) VALUES(?,?,?,?,?,?,?)').run(username,email,hash,'admin','PAID','FULL_COURSE','ACTIVE');
    res.json({admin:db.prepare("SELECT id,username,email,account_status,created_at FROM users WHERE id=?").get(r.lastInsertRowid)});
  }catch(e){res.status(409).json({error:'Admin username or email already exists.'});}
});

app.put('/api/admin/account',admin,(req,res)=>{
  const id=req.session.userId;
  const existing=db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(id);
  if(!existing) return res.status(404).json({error:'Admin account not found.'});
  const username=String(req.body?.username ?? existing.username).trim();
  const email=String(req.body?.email ?? existing.email ?? '').trim()||null;
  const password=String(req.body?.password||'');
  if(!username) return res.status(400).json({error:'Username is required.'});
  try{
    if(password){
      if(password.length<4) return res.status(400).json({error:'Password must contain at least 4 characters.'});
      const hash=bcrypt.hashSync(password,12);
      db.prepare('UPDATE users SET username=?,email=?,password_hash=? WHERE id=?').run(username,email,hash,id);
    } else db.prepare('UPDATE users SET username=?,email=? WHERE id=?').run(username,email,id);
    res.json({user:safe(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
  }catch(e){res.status(409).json({error:'Username or email already exists.'});}
});

app.put('/api/admin/settings',admin,(req,res)=>{
  const n=String(req.body?.whatsapp_number||'').replace(/[^0-9]/g,'');
  if(!n) return res.status(400).json({error:'Invalid WhatsApp number'});
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('whatsapp_number',n);
  res.json({ok:true,whatsapp_number:n});
});

// Course and video management -------------------------------------------------
app.get('/api/admin/courses',admin,(req,res)=>res.json({courses:getCourses()}));
app.post('/api/admin/courses',adminManage,(req,res)=>{
  const name=String(req.body?.name||'').trim();
  const subtitle=String(req.body?.subtitle||'').trim();
  const image=String(req.body?.image||'').trim();
  if(!name) return res.status(400).json({error:'Course name is required.'});
  const courses=getCourses();
  if(courses.some(c=>c.name.toLowerCase()===name.toLowerCase())) return res.status(409).json({error:'A course with this name already exists.'});
  const course={name,subtitle,image,videos:[]};
  courses.push(course); saveCourses(courses); res.json({course,courses});
});
app.put('/api/admin/courses/:index',adminManage,(req,res)=>{
  const index=Number(req.params.index); const courses=getCourses();
  if(!Number.isInteger(index)||!courses[index]) return res.status(404).json({error:'Course not found.'});
  const c=courses[index]; c.name=String(req.body?.name ?? c.name).trim(); c.subtitle=String(req.body?.subtitle ?? c.subtitle).trim(); c.image=String(req.body?.image ?? c.image).trim();
  if(!c.name) return res.status(400).json({error:'Course name is required.'});
  courses[index]=c; saveCourses(courses); res.json({course:c,courses});
});
app.delete('/api/admin/courses/:index',adminManage,(req,res)=>{
  const index=Number(req.params.index); const courses=getCourses();
  if(!Number.isInteger(index)||!courses[index]) return res.status(404).json({error:'Course not found.'});
  courses.splice(index,1); saveCourses(courses); res.json({courses});
});
app.post('/api/admin/courses/:index/videos',adminManage,(req,res)=>{
  const index=Number(req.params.index); const courses=getCourses(); const c=courses[index];
  if(!c) return res.status(404).json({error:'Course not found.'});
  const title=String(req.body?.title||'').trim(); const link=String(req.body?.link||'').trim(); const duration=String(req.body?.duration||'').trim(); const access=req.body?.access==='PREVIEW'?'PREVIEW':'FULL';
  if(!title||!link) return res.status(400).json({error:'Video title and YouTube link are required.'});
  const m=link.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  if(!m) return res.status(400).json({error:'Please enter a valid YouTube URL.'});
  c.videos.push({title,source:'youtube',id:m[1],duration,access}); saveCourses(courses); res.json({course:c,courses});
});
app.put('/api/admin/courses/:courseIndex/videos/:videoIndex',adminManage,(req,res)=>{
  const ci=Number(req.params.courseIndex),vi=Number(req.params.videoIndex),courses=getCourses(); const c=courses[ci];
  if(!c||!c.videos[vi]) return res.status(404).json({error:'Video not found.'});
  const v=c.videos[vi]; const title=String(req.body?.title ?? v.title).trim(); const link=String(req.body?.link ?? ('https://www.youtube.com/watch?v='+v.id)).trim(); const duration=String(req.body?.duration ?? v.duration ?? '').trim(); const access=req.body?.access==='PREVIEW'?'PREVIEW':'FULL';
  const m=link.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/); if(!m) return res.status(400).json({error:'Please enter a valid YouTube URL.'});
  c.videos[vi]={...v,title,id:m[1],source:'youtube',duration,access}; saveCourses(courses); res.json({course:c,courses});
});
app.delete('/api/admin/courses/:courseIndex/videos/:videoIndex',adminManage,(req,res)=>{
  const ci=Number(req.params.courseIndex),vi=Number(req.params.videoIndex),courses=getCourses(); const c=courses[ci];
  if(!c||!c.videos[vi]) return res.status(404).json({error:'Video not found.'}); c.videos.splice(vi,1); saveCourses(courses); res.json({course:c,courses});
});
app.post('/api/admin/upload-image',adminManage,(req,res)=>{
  const data=String(req.body?.data||''); const name=String(req.body?.name||'course-image').replace(/[^a-z0-9_-]/gi,'').slice(0,60)||'course-image';
  const m=data.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/); if(!m) return res.status(400).json({error:'Only PNG, JPG or WEBP images are supported.'});
  const ext=m[1]==='jpeg'?'jpg':m[1]; const buf=Buffer.from(m[2],'base64'); if(buf.length>3*1024*1024) return res.status(400).json({error:'Image must be 3 MB or smaller.'});
  fs.mkdirSync(path.join(__dirname,'public','uploads'),{recursive:true}); const file=`${name}-${Date.now()}.${ext}`; fs.writeFileSync(path.join(__dirname,'public','uploads',file),buf); res.json({url:`/uploads/${file}`});
});
app.put('/api/admin/site-settings',admin,(req,res)=>{
  const fields={academy_name:String(req.body?.academy_name||'HAIRATH ACADEMY').trim(),academy_tagline:String(req.body?.academy_tagline||'RESEARCH AND EDUCATION DEVELOPMENT').trim(),facebook_url:String(req.body?.facebook_url||'https://www.facebook.com/HairathAcademy/').trim()};
  for(const [k,v] of Object.entries(fields)) db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v);
  res.json(fields);
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Course platform running on http://localhost:${PORT}`));
