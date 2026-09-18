require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('ERROR: Supabase environment variables are missing.');
  console.error('Required: SUPABASE_URL and SUPABASE_SECRET_KEY');
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const appData = {
  academy_name: 'HAIRATH ACADEMY',
  academy_tagline: 'FOR RESEARCH AND EDUCATION DEVELOPMENT',
  facebook_url: 'https://www.facebook.com/HairathAcademy/',
  whatsapp_number: process.env.WHATSAPP_NUMBER || '94777122951'
};

const adminUsername =
  process.env.ADMIN_USERNAME || 'admin';

const adminPassword =
  process.env.ADMIN_PASSWORD || 'ChangeMeNow!2026';

const adminManagePassword =
  process.env.ADMIN_MANAGE_PASSWORD || '3833';


// ============================================================
// EXPRESS
// ============================================================

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );

    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Credentials',
      'true'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,DELETE,OPTIONS'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      'hairath-academy-change-this-secret',

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure:
        process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


// ============================================================
// HELPERS
// ============================================================

function safeStudent(student) {
  if (!student) return null;

  return {
    id: student.id,
    username: student.username,
    email: student.email || '',
    full_name: student.full_name || '',
    payment_status: 'PAID',
    access_level: 'FULL_COURSE',
    account_status:
      student.is_active === false
        ? 'SUSPENDED'
        : 'ACTIVE',
    created_at: student.created_at
  };
}

function safeAdmin(admin) {
  if (!admin) return null;

  return {
    id: admin.id,
    username: admin.username,
    email: admin.email || '',
    full_name: admin.full_name || '',
    role: 'admin',
    account_status:
      admin.is_active === false
        ? 'SUSPENDED'
        : 'ACTIVE',
    created_at: admin.created_at
  };
}

async function getCurrentUser(req) {
  if (!req.session.userId) {
    return null;
  }

  if (req.session.userRole === 'admin') {
    const { data, error } = await supabase
      .from('admins')
      .select('*')
      .eq('id', req.session.userId)
      .maybeSingle();

    if (error || !data || !data.is_active) {
      return null;
    }

    return {
      ...data,
      role: 'admin'
    };
  }

  const { data, error } = await supabase
    .from('students')
    .select('*')
    .eq('id', req.session.userId)
    .maybeSingle();

  if (error || !data || !data.is_active) {
    return null;
  }

  return {
    ...data,
    role: 'student'
  };
}

async function requireAdmin(req, res, next) {
  const user = await getCurrentUser(req);

  if (
    !user ||
    user.role !== 'admin' ||
    !user.is_active
  ) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }

  req.user = user;

  next();
}

async function requireAdminManagement(
  req,
  res,
  next
) {
  const user = await getCurrentUser(req);

  if (
    !user ||
    user.role !== 'admin' ||
    !user.is_active
  ) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }

  const supplied =
    String(
      req.body?.manage_password || ''
    );

  if (supplied !== adminManagePassword) {
    return res.status(403).json({
      error:
        'Management password is incorrect.'
    });
  }

  req.user = user;

  next();
}

function extractYouTubeId(url) {
  const value = String(url || '').trim();

  const match = value.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/
  );

  return match ? match[1] : null;
}

function youtubeUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}


// ============================================================
// COURSES
// ============================================================

async function loadCourses() {
  const { data, error } = await supabase
    .from('courses')
    .select(`
      id,
      title,
      description,
      thumbnail_url,
      is_active,
      display_order,
      created_at,
      updated_at,
      course_videos (
        id,
        course_id,
        title,
        youtube_url,
        duration,
        is_locked,
        is_active,
        display_order,
        created_at,
        updated_at
      )
    `)
    .eq('is_active', true)
    .order('display_order', {
      ascending: true
    });

  if (error) {
    console.error(
      'loadCourses error:',
      error
    );

    throw error;
  }

  return (data || []).map(course => {
    const videos =
      (course.course_videos || [])
        .filter(v => v.is_active !== false)
        .sort(
          (a, b) =>
            (a.display_order || 0) -
            (b.display_order || 0)
        );

    return {
      id: course.id,

      name: course.title,

      title: course.title,

      subtitle: course.description || '',

      description:
        course.description || '',

      image:
        course.thumbnail_url || '',

      thumbnail_url:
        course.thumbnail_url || '',

      display_order:
        course.display_order || 0,

      videos: videos.map(video => {
        const id =
          extractYouTubeId(
            video.youtube_url
          );

        return {
          id: video.id,

          title: video.title,

          source: 'youtube',

          youtube_url:
            video.youtube_url,

          link:
            video.youtube_url,

          video_id: id,

          duration:
            video.duration || '',

          access:
            video.is_locked
              ? 'LOCKED'
              : 'FULL',

          is_locked:
            !!video.is_locked,

          locked:
            !!video.is_locked
        };
      })
    };
  });
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  async (req, res) => {
    try {
      const { error } =
        await supabase
          .from('courses')
          .select('id')
          .limit(1);

      if (error) {
        return res.status(500).json({
          ok: false,
          service:
            'hairath-academy-course-platform',
          database: 'error',
          error: error.message
        });
      }

      res.json({
        ok: true,
        service:
          'hairath-academy-course-platform',
        database: 'supabase'
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);


// ============================================================
// CONFIG
// ============================================================

app.get(
  '/api/config',
  (req, res) => {
    res.json({
      whatsapp_number:
        appData.whatsapp_number,

      academy_name:
        appData.academy_name,

      academy_tagline:
        appData.academy_tagline,

      facebook_url:
        appData.facebook_url
    });
  }
);


// ============================================================
// COURSES PUBLIC
// ============================================================

app.get(
  '/api/courses',
  async (req, res) => {
    try {
      const courses =
        await loadCourses();

      const user =
        await getCurrentUser(req);

      const isFullAccess =
        user &&
        (
          user.role === 'admin' ||
          user.role === 'student'
        );

      const output =
        courses.map(course => ({
          ...course,

          videos:
            course.videos.map(
              (video, index) => {
                let locked = true;

                if (isFullAccess) {
                  locked = false;
                } else if (index === 0) {
                  locked = false;
                }

                return {
                  ...video,

                  access:
                    locked
                      ? 'LOCKED'
                      : 'PREVIEW',

                  locked
                };
              }
            )
        }));

      res.json({
        courses: output
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          'Unable to load courses.'
      });
    }
  }
);


// ============================================================
// CURRENT USER
// ============================================================

app.get(
  '/api/me',
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.json({
          user: null
        });
      }

      res.json({
        user:
          user.role === 'admin'
            ? safeAdmin(user)
            : safeStudent(user)
      });

    } catch (error) {
      res.json({
        user: null
      });
    }
  }
);


// ============================================================
// LOGIN
// ============================================================

app.post(
  '/api/login',
  async (req, res) => {
    try {
      const username =
        String(
          req.body?.username || ''
        ).trim();

      const password =
        String(
          req.body?.password || ''
        );

      if (!username || !password) {
        return res.status(400).json({
          error:
            'Username and password are required.'
        });
      }

      // --------------------------
      // ADMIN
      // --------------------------

      const adminResult =
        await supabase
          .from('admins')
          .select('*')
          .or(
            `username.eq.${username}`
          )
          .maybeSingle();

      if (
        adminResult.data &&
        adminResult.data.is_active
      ) {
        const valid =
          await bcrypt.compare(
            password,
            adminResult.data.password_hash
          );

        if (valid) {
          req.session.userId =
            adminResult.data.id;

          req.session.userRole =
            'admin';

          return res.json({
            user:
              safeAdmin(
                adminResult.data
              )
          });
        }
      }

      // --------------------------
      // STUDENT
      // --------------------------

      const studentResult =
        await supabase
          .from('students')
          .select('*')
          .or(
            `username.eq.${username},email.eq.${username}`
          )
          .maybeSingle();

      if (
        studentResult.data &&
        studentResult.data.is_active
      ) {
        const valid =
          await bcrypt.compare(
            password,
            studentResult.data.password_hash
          );

        if (valid) {
          req.session.userId =
            studentResult.data.id;

          req.session.userRole =
            'student';

          return res.json({
            user:
              safeStudent(
                studentResult.data
              )
          });
        }
      }

      return res.status(401).json({
        error:
          'Invalid username/email or password.'
      });

    } catch (error) {
      console.error(
        'Login error:',
        error
      );

      res.status(500).json({
        error: 'Login failed.'
      });
    }
  }
);


// ============================================================
// LOGOUT
// ============================================================

app.post(
  '/api/logout',
  (req, res) => {
    req.session.destroy(() => {
      res.json({
        ok: true
      });
    });
  }
);


// ============================================================
// MANAGEMENT PASSWORD VERIFY
// ============================================================

app.post(
  '/api/admin/verify-management',
  requireAdmin,
  (req, res) => {
    const supplied =
      String(
        req.body?.manage_password || ''
      );

    if (
      supplied !== adminManagePassword
    ) {
      return res.status(403).json({
        error:
          'Management password is incorrect.'
      });
    }

    res.json({
      ok: true
    });
  }
);


// ============================================================
// STUDENTS
// ============================================================

app.get(
  '/api/admin/students',
  requireAdmin,
  async (req, res) => {
    const { data, error } =
      await supabase
        .from('students')
        .select(
          'id,username,email,full_name,is_active,created_at'
        )
        .order(
          'created_at',
          { ascending: false }
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      students:
        (data || []).map(
          safeStudent
        )
    });
  }
);


// ============================================================
// ADD STUDENT
// ============================================================

app.post(
  '/api/admin/students',
  requireAdmin,
  async (req, res) => {
    try {
      const username =
        String(
          req.body?.username || ''
        ).trim();

      const email =
        String(
          req.body?.email || ''
        ).trim() || null;

      const full_name =
        String(
          req.body?.full_name || ''
        ).trim();

      const password =
        String(
          req.body?.password || ''
        );

      if (!username || !password) {
        return res.status(400).json({
          error:
            'Username and password are required.'
        });
      }

      if (
        !/^[A-Za-z0-9._-]{3,50}$/.test(
          username
        )
      ) {
        return res.status(400).json({
          error:
            'Username must contain 3-50 letters, numbers, dot, underscore or hyphen.'
        });
      }

      if (password.length < 4) {
        return res.status(400).json({
          error:
            'Password must contain at least 4 characters.'
        });
      }

      const password_hash =
        await bcrypt.hash(
          password,
          12
        );

      const { data, error } =
        await supabase
          .from('students')
          .insert({
            username,
            email,
            full_name,
            password_hash,
            is_active: true
          })
          .select()
          .single();

      if (error) {
        return res.status(409).json({
          error:
            'Username or email already exists.'
        });
      }

      res.json({
        student:
          safeStudent(data)
      });

    } catch (error) {
      res.status(500).json({
        error:
          'Unable to create student.'
      });
    }
  }
);


// ============================================================
// EDIT STUDENT
// ============================================================

app.put(
  '/api/admin/students/:id',
  requireAdmin,
  async (req, res) => {
    const id =
      req.params.id;

    const { data: existing } =
      await supabase
        .from('students')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (!existing) {
      return res.status(404).json({
        error:
          'Student not found.'
      });
    }

    const updates = {};

    if (
      req.body.username !==
      undefined
    ) {
      updates.username =
        String(
          req.body.username
        ).trim();
    }

    if (
      req.body.email !==
      undefined
    ) {
      updates.email =
        String(
          req.body.email || ''
        ).trim() || null;
    }

    if (
      req.body.full_name !==
      undefined
    ) {
      updates.full_name =
        String(
          req.body.full_name || ''
        ).trim();
    }

    if (
      req.body.account_status !==
      undefined
    ) {
      updates.is_active =
        req.body.account_status ===
        'ACTIVE';
    }

    if (req.body.password) {
      if (
        String(req.body.password)
          .length < 4
      ) {
        return res.status(400).json({
          error:
            'Password must contain at least 4 characters.'
        });
      }

      updates.password_hash =
        await bcrypt.hash(
          String(req.body.password),
          12
        );
    }

    const { data, error } =
      await supabase
        .from('students')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
      return res.status(409).json({
        error:
          'Unable to update student.'
      });
    }

    res.json({
      student:
        safeStudent(data)
    });
  }
);


// ============================================================
// DELETE STUDENT
// ============================================================

app.delete(
  '/api/admin/students/:id',
  requireAdmin,
  async (req, res) => {
    const { error } =
      await supabase
        .from('students')
        .delete()
        .eq(
          'id',
          req.params.id
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);


// ============================================================
// ADMINS
// ============================================================

app.get(
  '/api/admin/admins',
  requireAdmin,
  async (req, res) => {
    const { data, error } =
      await supabase
        .from('admins')
        .select(
          'id,username,full_name,is_active,created_at'
        )
        .order(
          'created_at',
          { ascending: true }
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      admins:
        (data || []).map(
          safeAdmin
        )
    });
  }
);


// ============================================================
// ADD ADMIN
// ============================================================

app.post(
  '/api/admin/admins',
  requireAdmin,
  async (req, res) => {
    const username =
      String(
        req.body?.username || ''
      ).trim();

    const full_name =
      String(
        req.body?.full_name || ''
      ).trim();

    const password =
      String(
        req.body?.password || ''
      );

    if (!username || !password) {
      return res.status(400).json({
        error:
          'Admin username and password are required.'
      });
    }

    const password_hash =
      await bcrypt.hash(
        password,
        12
      );

    const { data, error } =
      await supabase
        .from('admins')
        .insert({
          username,
          full_name,
          password_hash,
          is_active: true
        })
        .select()
        .single();

    if (error) {
      return res.status(409).json({
        error:
          'Admin username already exists.'
      });
    }

    res.json({
      admin:
        safeAdmin(data)
    });
  }
);


// ============================================================
// COURSE ADMIN
// ============================================================

app.get(
  '/api/admin/courses',
  requireAdmin,
  async (req, res) => {
    try {
      const courses =
        await loadCourses();

      res.json({
        courses
      });

    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }
);


// ============================================================
// ADD COURSE
// ============================================================

app.post(
  '/api/admin/courses',
  requireAdminManagement,
  async (req, res) => {
    const title =
      String(
        req.body?.title ||
        req.body?.name ||
        ''
      ).trim();

    const description =
      String(
        req.body?.description ||
        req.body?.subtitle ||
        ''
      ).trim();

    const thumbnail_url =
      String(
        req.body?.thumbnail_url ||
        req.body?.image ||
        ''
      ).trim();

    if (!title) {
      return res.status(400).json({
        error:
          'Course name is required.'
      });
    }

    const { data: duplicate } =
      await supabase
        .from('courses')
        .select('id')
        .ilike(
          'title',
          title
        )
        .maybeSingle();

    if (duplicate) {
      return res.status(409).json({
        error:
          'A course with this name already exists.'
      });
    }

    const { data, error } =
      await supabase
        .from('courses')
        .insert({
          title,
          description,
          thumbnail_url,
          is_active: true,
          display_order: 9999
        })
        .select()
        .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      course: {
        id: data.id,
        name: data.title,
        title: data.title,
        subtitle:
          data.description || '',
        description:
          data.description || '',
        image:
          data.thumbnail_url || '',
        thumbnail_url:
          data.thumbnail_url || '',
        videos: []
      }
    });
  }
);


// ============================================================
// EDIT COURSE
// ============================================================

app.put(
  '/api/admin/courses/:id',
  requireAdminManagement,
  async (req, res) => {
    const updates = {};

    if (
      req.body.title !==
      undefined ||
      req.body.name !==
      undefined
    ) {
      updates.title =
        String(
          req.body.title ??
          req.body.name
        ).trim();
    }

    if (
      req.body.description !==
      undefined ||
      req.body.subtitle !==
      undefined
    ) {
      updates.description =
        String(
          req.body.description ??
          req.body.subtitle ??
          ''
        ).trim();
    }

    if (
      req.body.thumbnail_url !==
      undefined ||
      req.body.image !==
      undefined
    ) {
      updates.thumbnail_url =
        String(
          req.body.thumbnail_url ??
          req.body.image ??
          ''
        ).trim();
    }

    const { data, error } =
      await supabase
        .from('courses')
        .update(updates)
        .eq(
          'id',
          req.params.id
        )
        .select()
        .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      course: {
        id: data.id,
        name: data.title,
        title: data.title,
        subtitle:
          data.description || '',
        description:
          data.description || '',
        image:
          data.thumbnail_url || '',
        thumbnail_url:
          data.thumbnail_url || ''
      }
    });
  }
);


// ============================================================
// DELETE COURSE
// ============================================================

app.delete(
  '/api/admin/courses/:id',
  requireAdminManagement,
  async (req, res) => {
    const { error } =
      await supabase
        .from('courses')
        .delete()
        .eq(
          'id',
          req.params.id
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);


// ============================================================
// ADD VIDEO
// ============================================================

app.post(
  '/api/admin/courses/:courseId/videos',
  requireAdminManagement,
  async (req, res) => {
    const title =
      String(
        req.body?.title || ''
      ).trim();

    const link =
      String(
        req.body?.link ||
        req.body?.youtube_url ||
        ''
      ).trim();

    const duration =
      String(
        req.body?.duration || ''
      ).trim();

    const youtubeId =
      extractYouTubeId(link);

    if (!title || !link) {
      return res.status(400).json({
        error:
          'Video title and YouTube link are required.'
      });
    }

    if (!youtubeId) {
      return res.status(400).json({
        error:
          'Please enter a valid YouTube URL.'
      });
    }

    const { data: course } =
      await supabase
        .from('courses')
        .select('id')
        .eq(
          'id',
          req.params.courseId
        )
        .maybeSingle();

    if (!course) {
      return res.status(404).json({
        error:
          'Course not found.'
      });
    }

    const { data: video, error } =
      await supabase
        .from('course_videos')
        .insert({
          course_id:
            req.params.courseId,

          title,

          youtube_url:
            youtubeUrl(youtubeId),

          duration,

          is_locked: false,

          is_active: true,

          display_order: 9999
        })
        .select()
        .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      video
    });
  }
);


// ============================================================
// EDIT VIDEO
// ============================================================

app.put(
  '/api/admin/courses/:courseId/videos/:videoId',
  requireAdminManagement,
  async (req, res) => {
    const updates = {};

    if (
      req.body.title !==
      undefined
    ) {
      updates.title =
        String(
          req.body.title
        ).trim();
    }

    if (
      req.body.link !==
      undefined ||
      req.body.youtube_url !==
      undefined
    ) {
      const link =
        String(
          req.body.link ??
          req.body.youtube_url ??
          ''
        ).trim();

      const id =
        extractYouTubeId(link);

      if (!id) {
        return res.status(400).json({
          error:
            'Please enter a valid YouTube URL.'
        });
      }

      updates.youtube_url =
        youtubeUrl(id);
    }

    if (
      req.body.duration !==
      undefined
    ) {
      updates.duration =
        String(
          req.body.duration || ''
        ).trim();
    }

    if (
      req.body.is_locked !==
      undefined
    ) {
      updates.is_locked =
        !!req.body.is_locked;
    }

    if (
      req.body.access !==
      undefined
    ) {
      updates.is_locked =
        req.body.access ===
        'LOCKED';
    }

    const { data, error } =
      await supabase
        .from('course_videos')
        .update(updates)
        .eq(
          'id',
          req.params.videoId
        )
        .eq(
          'course_id',
          req.params.courseId
        )
        .select()
        .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      video: data
    });
  }
);


// ============================================================
// DELETE VIDEO
// ============================================================

app.delete(
  '/api/admin/courses/:courseId/videos/:videoId',
  requireAdminManagement,
  async (req, res) => {
    const { error } =
      await supabase
        .from('course_videos')
        .delete()
        .eq(
          'id',
          req.params.videoId
        )
        .eq(
          'course_id',
          req.params.courseId
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);


// ============================================================
// LOCK / UNLOCK VIDEO
// ============================================================

app.put(
  '/api/admin/videos/:videoId/lock',
  requireAdminManagement,
  async (req, res) => {
    const locked =
      req.body?.locked !==
      undefined
        ? !!req.body.locked
        : true;

    const { data, error } =
      await supabase
        .from('course_videos')
        .update({
          is_locked: locked
        })
        .eq(
          'id',
          req.params.videoId
        )
        .select()
        .single();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true,
      video: data
    });
  }
);


// ============================================================
// UPLOAD COURSE THUMBNAIL
// ============================================================

app.post(
  '/api/admin/upload-image',
  requireAdminManagement,
  async (req, res) => {
    try {
      const data =
        String(
          req.body?.data || ''
        );

      const name =
        String(
          req.body?.name ||
          'course-image'
        )
          .replace(
            /[^a-z0-9_-]/gi,
            ''
          )
          .slice(0, 60) ||
        'course-image';

      const match =
        data.match(
          /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/
        );

      if (!match) {
        return res.status(400).json({
          error:
            'Only PNG, JPG or WEBP images are supported.'
        });
      }

      const ext =
        match[1] === 'jpeg'
          ? 'jpg'
          : match[1];

      const buffer =
        Buffer.from(
          match[2],
          'base64'
        );

      if (
        buffer.length >
        3 * 1024 * 1024
      ) {
        return res.status(400).json({
          error:
            'Image must be 3 MB or smaller.'
        });
      }

      const fileName =
        `${name}-${Date.now()}.${ext}`;

      const { error } =
        await supabase
          .storage
          .from(
            'course-thumbnails'
          )
          .upload(
            fileName,
            buffer,
            {
              contentType:
                `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              upsert: false
            }
          );

      if (error) {
        return res.status(500).json({
          error:
            'Image upload failed: ' +
            error.message
        });
      }

      const { data: publicData } =
        supabase
          .storage
          .from(
            'course-thumbnails'
          )
          .getPublicUrl(
            fileName
          );

      res.json({
        url:
          publicData.publicUrl,

        path:
          fileName
      });

    } catch (error) {
      res.status(500).json({
        error:
          'Image upload failed.'
      });
    }
  }
);


// ============================================================
// SITE SETTINGS
// ============================================================

app.put(
  '/api/admin/site-settings',
  requireAdmin,
  (req, res) => {
    if (
      req.body.academy_name
    ) {
      appData.academy_name =
        String(
          req.body.academy_name
        ).trim();
    }

    if (
      req.body.academy_tagline
    ) {
      appData.academy_tagline =
        String(
          req.body.academy_tagline
        ).trim();
    }

    if (
      req.body.facebook_url
    ) {
      appData.facebook_url =
        String(
          req.body.facebook_url
        ).trim();
    }

    res.json({
      ...appData
    });
  }
);


// ============================================================
// WHATSAPP
// ============================================================

app.put(
  '/api/admin/settings',
  requireAdmin,
  (req, res) => {
    const number =
      String(
        req.body?.whatsapp_number ||
        ''
      ).replace(
        /[^0-9]/g,
        ''
      );

    if (!number) {
      return res.status(400).json({
        error:
          'Invalid WhatsApp number.'
      });
    }

    appData.whatsapp_number =
      number;

    res.json({
      ok: true,
      whatsapp_number:
        number
    });
  }
);


// ============================================================
// STUDENT PROGRESS
// ============================================================

app.get(
  '/api/student/progress',
  async (req, res) => {
    const user =
      await getCurrentUser(req);

    if (
      !user ||
      user.role !== 'student'
    ) {
      return res.status(403).json({
        error:
          'Student access required'
      });
    }

    const { data, error } =
      await supabase
        .from(
          'student_video_access'
        )
        .select(`
          video_id,
          last_watched_at
        `)
        .eq(
          'student_id',
          user.id
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      progress:
        data || []
    });
  }
);


// ============================================================
// SAVE STUDENT VIDEO PROGRESS
// ============================================================

app.post(
  '/api/student/progress',
  async (req, res) => {
    const user =
      await getCurrentUser(req);

    if (
      !user ||
      user.role !== 'student'
    ) {
      return res.status(403).json({
        error:
          'Student access required'
      });
    }

    const videoId =
      req.body?.video_id;

    if (!videoId) {
      return res.status(400).json({
        error:
          'video_id is required.'
      });
    }

    const { error } =
      await supabase
        .from(
          'student_video_access'
        )
        .upsert(
          {
            student_id:
              user.id,

            video_id:
              videoId,

            last_watched_at:
              new Date().toISOString()
          },
          {
            onConflict:
              'student_id,video_id'
          }
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      ok: true
    });
  }
);


// ============================================================
// ADMIN STUDENT PROGRESS
// ============================================================

app.get(
  '/api/admin/student-progress/:id',
  requireAdmin,
  async (req, res) => {
    const studentId =
      req.params.id;

    const { data: student } =
      await supabase
        .from('students')
        .select(
          'id,username,email,full_name'
        )
        .eq(
          'id',
          studentId
        )
        .maybeSingle();

    if (!student) {
      return res.status(404).json({
        error:
          'Student not found.'
      });
    }

    const { data, error } =
      await supabase
        .from(
          'student_video_access'
        )
        .select('*')
        .eq(
          'student_id',
          studentId
        );

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    res.json({
      student,
      progress:
        data || []
    });
  }
);


// ============================================================
// LOGIN HISTORY
// ============================================================

app.get(
  '/api/admin/login-history',
  requireAdmin,
  (req, res) => {
    res.json({
      history: []
    });
  }
);


// ============================================================
// ROOT / SPA
// ============================================================

app.get(
  '*',
  (req, res) => {
    const indexPath =
      path.join(
        __dirname,
        'public',
        'index.html'
      );

    if (
      fs.existsSync(indexPath)
    ) {
      return res.sendFile(
        indexPath
      );
    }

    res.status(404).send(
      'HAIRATH ACADEMY'
    );
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `HAIRATH ACADEMY running on port ${PORT}`
    );
  }
);
