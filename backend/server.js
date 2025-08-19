const express = require("express");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const FacultyDB = require("./db/faculty");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
let facultyDB;

// Allow frontend access
app.use(cors({
  origin: ["https://faculty-status-display.vercel.app", "http://localhost:3000"],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "secret123",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// === MIDDLEWARE ===
// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

// Serve images
app.use("/images", express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/ads", express.static(path.join(__dirname, "public/ads")));

// === SYNC FUNCTION ===
async function syncFacultyFromJSON() {
  const jsonPath = path.join(__dirname, "faculty.json");
  
  if (!fs.existsSync(jsonPath)) {
    console.log('No faculty.json found for sync');
    return;
  }

  try {
    const db = await facultyDB.connect();
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    // Get existing faculty with their current overrides
    const existingFaculty = await db.collection('faculty').find({}).toArray();
    const overrideMap = new Map();
    
    existingFaculty.forEach(f => {
      if (f.manualOverride && f.overrideExpiry) {
        const expiry = new Date(f.overrideExpiry);
        if (expiry > new Date()) {
          overrideMap.set(f.name, {
            manualOverride: f.manualOverride,
            overrideExpiry: f.overrideExpiry
          });
        }
      }
    });
    
    // Clear existing faculty data and replace with JSON data
    await db.collection('faculty').deleteMany({});
    
    for (const faculty of jsonData) {
      const facultyData = {
        ...faculty,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      // Preserve valid manual overrides
      if (overrideMap.has(faculty.name)) {
        const override = overrideMap.get(faculty.name);
        facultyData.manualOverride = override.manualOverride;
        facultyData.overrideExpiry = override.overrideExpiry;
      }
      
      await db.collection('faculty').insertOne(facultyData);
    }
    
    console.log(`✅ Synced ${jsonData.length} faculty records from faculty.json to database`);
  } catch (error) {
    console.error("❌ Error syncing from faculty.json:", error);
    throw error;
  }
}

// === API ROUTES ===
app.get("/api/faculty", async (req, res) => {
  try {
    // Check if faculty.json exists and has been updated
    const jsonPath = path.join(__dirname, "faculty.json");
    if (fs.existsSync(jsonPath)) {
      const jsonStat = fs.statSync(jsonPath);
      
      // Check if we need to sync from file
      const lastSync = await facultyDB.getSetting('last_faculty_sync');
      const jsonModified = jsonStat.mtime.toISOString();
      
      if (!lastSync || jsonModified > lastSync) {
        console.log("📄 faculty.json has been updated, syncing to database...");
        await syncFacultyFromJSON();
        await facultyDB.setSetting('last_faculty_sync', jsonModified);
      }
    }
    
    // Get faculty data from database
    const faculty = await facultyDB.getAllFaculty();
    res.json(faculty);
  } catch (error) {
    console.error("❌ Error fetching faculty:", error);
    res.status(500).json({ error: "Failed to fetch faculty data" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "admin123") {
    req.session.loggedIn = true;
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

app.post("/api/update", requireAuth, async (req, res) => {
  const overrides = req.body;

  try {
    const result = await facultyDB.bulkUpdateOverrides(overrides);
    console.log(`✅ Updated ${result} faculty records`);
    res.json({ message: "Faculty data updated successfully." });
  } catch (error) {
    console.error("❌ Error updating faculty:", error);
    res.status(500).json({ error: "Failed to update faculty data" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/api/check-login", (req, res) => {
  if (req.session.loggedIn) {
    res.json({ loggedIn: true });
  } else {
    res.status(401).json({ loggedIn: false });
  }
});

app.get("/api/ads", (req, res) => {
  const adsDir = path.join(__dirname, "public/ads");
  fs.readdir(adsDir, (err, files) => {
    if (err) return res.status(500).json({ error: "Failed to read ads directory" });
    const ads = files
      .filter(f => /\.(jpg|jpeg|png|gif|mp4|webm)$/i.test(f))
      .map(f => ({
        type: /\.(mp4|webm)$/i.test(f) ? "video" : "image",
        src: `/ads/${f}`
      }));
    res.json(ads);
  });
});

// HYBRID MARQUEE - File takes precedence over database
app.get("/api/marquee", async (req, res) => {
  try {
    // Try file first (takes precedence)
    const marqueePath = path.join(__dirname, "public/marquee.txt");
    if (fs.existsSync(marqueePath)) {
      const fileMarquee = fs.readFileSync(marqueePath, 'utf8').trim();
      if (fileMarquee) {
        // Update database with file content
        await facultyDB.setSetting('marquee_text', fileMarquee);
        console.log("📄 Using marquee text from marquee.txt file");
        return res.send(fileMarquee);
      }
    }
    
    // Fallback to database
    const dbMarquee = await facultyDB.getSetting('marquee_text');
    if (dbMarquee) {
      console.log("💾 Using marquee text from database");
      return res.send(dbMarquee);
    }
    
    // Default fallback
    console.log("🔤 Using default marquee text");
    res.send('Welcome to Faculty Status Display');
  } catch (error) {
    console.error("❌ Error fetching marquee:", error);
    res.send('Welcome to Faculty Status Display');
  }
});

app.get("/", (req, res) => {
  res.send("Faculty Status Backend with MongoDB (Hybrid File/DB) - Running! 🚀");
});

// === ADMIN ROUTES ===

// Get single faculty member
app.get("/api/admin/faculty/:name", requireAuth, async (req, res) => {
  try {
    const faculty = await facultyDB.getAllFaculty();
    const member = faculty.find(f => f.name === req.params.name);
    if (!member) return res.status(404).json({ error: "Faculty not found" });
    res.json(member);
  } catch (error) {
    console.error("Error fetching faculty:", error);
    res.status(500).json({ error: "Failed to fetch faculty" });
  }
});

// Add new faculty member
app.post("/api/admin/faculty", requireAuth, async (req, res) => {
  try {
    const db = await facultyDB.connect();
    const newFaculty = {
      ...req.body,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "off_duty",
      manualOverride: null,
      overrideExpiry: null
    };
    
    // Check if faculty already exists
    const existing = await db.collection('faculty').findOne({ name: newFaculty.name });
    if (existing) {
      return res.status(400).json({ error: "Faculty with this name already exists" });
    }
    
    await db.collection('faculty').insertOne(newFaculty);
    console.log(`✅ Added new faculty: ${newFaculty.name}`);
    res.json({ message: "Faculty added successfully" });
  } catch (error) {
    console.error("Error adding faculty:", error);
    res.status(500).json({ error: "Failed to add faculty" });
  }
});

// Update faculty member (schedule, contact info, etc.)
app.put("/api/admin/faculty/:name", requireAuth, async (req, res) => {
  try {
    const db = await facultyDB.connect();
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };
    
    // Don't allow updating status, manualOverride, or overrideExpiry through this route
    delete updateData.status;
    delete updateData.manualOverride;
    delete updateData.overrideExpiry;
    delete updateData.createdAt;
    
    const result = await db.collection('faculty').updateOne(
      { name: req.params.name },
      { $set: updateData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Faculty not found" });
    }
    
    console.log(`✅ Updated faculty: ${req.params.name}`);
    res.json({ message: "Faculty updated successfully" });
  } catch (error) {
    console.error("Error updating faculty:", error);
    res.status(500).json({ error: "Failed to update faculty" });
  }
});

// Delete faculty member
app.delete("/api/admin/faculty/:name", requireAuth, async (req, res) => {
  try {
    const db = await facultyDB.connect();
    const result = await db.collection('faculty').deleteOne({ name: req.params.name });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Faculty not found" });
    }
    
    console.log(`✅ Deleted faculty: ${req.params.name}`);
    res.json({ message: "Faculty deleted successfully" });
  } catch (error) {
    console.error("Error deleting faculty:", error);
    res.status(500).json({ error: "Failed to delete faculty" });
  }
});

// Update marquee text (database version for admin panel)
app.post("/api/admin/marquee", requireAuth, async (req, res) => {
  const { text } = req.body;
  try {
    await facultyDB.setSetting('marquee_text', text);
    console.log("✅ Updated marquee text via admin panel");
    res.json({ message: "Marquee text updated successfully." });
  } catch (error) {
    console.error("❌ Error updating marquee:", error);
    res.status(500).json({ error: "Failed to update marquee text" });
  }
});

// GitHub file upload route
app.post("/api/upload", requireAuth, async (req, res) => {
  const { filename, content, path } = req.body;
  
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "GitHub token not configured. Upload manually to GitHub." });
  }

  try {
    const githubOwner = 'masud7866';
    const githubRepo = 'faculty-status-display';
    const filePath = `${path}/${filename}`;

    // Check if file already exists
    let sha = null;
    try {
      const existingFile = await fetch(
        `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${filePath}`,
        {
          headers: {
            'Authorization': `token ${process.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );
      
      if (existingFile.ok) {
        const fileData = await existingFile.json();
        sha = fileData.sha;
      }
    } catch (error) {
      // File doesn't exist, that's fine
    }

    // Upload/update file
    const uploadResponse = await fetch(
      `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Upload ${filename} via admin panel`,
          content: content,
          sha: sha // Include SHA if file exists (for update)
        })
      }
    );

    if (!uploadResponse.ok) {
      const error = await uploadResponse.json();
      throw new Error(error.message || 'GitHub upload failed');
    }

    const result = await uploadResponse.json();
    console.log(`✅ Uploaded ${filename} to GitHub: ${filePath}`);
    
    res.json({ 
      message: 'File uploaded successfully',
      path: filePath,
      url: result.content.download_url
    });

  } catch (error) {
    console.error('❌ GitHub upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// Delete ad file (admin only)
app.delete('/api/admin/ads/:filename', requireAuth, async (req, res) => {
  try {
      const filename = req.params.filename;
      
      if (!process.env.GITHUB_TOKEN) {
          return res.status(500).json({ error: 'GitHub token not configured' });
      }

      // Delete from GitHub
      const githubUrl = `https://api.github.com/repos/masud7866/faculty-status-display/contents/backend/public/ads/${filename}`;
      
      // First, get the file to get its SHA
      const getResponse = await fetch(githubUrl, {
          headers: {
              'Authorization': `token ${process.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json'
          }
      });

      if (!getResponse.ok) {
          if (getResponse.status === 404) {
              return res.status(404).json({ error: 'File not found' });
          }
          throw new Error(`GitHub API error: ${getResponse.status}`);
      }

      const fileData = await getResponse.json();
      
      // Delete the file
      const deleteResponse = await fetch(githubUrl, {
          method: 'DELETE',
          headers: {
              'Authorization': `token ${process.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json'
          },
          body: JSON.stringify({
              message: `Delete ad file: ${filename}`,
              sha: fileData.sha
          })
      });

      if (!deleteResponse.ok) {
          const error = await deleteResponse.json();
          throw new Error(error.message || 'Failed to delete file from GitHub');
      }

      res.json({ 
          success: true, 
          message: `File ${filename} deleted successfully`,
          filename: filename
      });

  } catch (error) {
      console.error('Delete ad error:', error);
      res.status(500).json({ 
          error: error.message || 'Failed to delete advertisement file' 
      });
  }
});

// === AUTO STATUS LOGIC ===
function getCurrentStatus(faculty) {
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    weekday: 'long'
  }).format(new Date());
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());

  // Check manual override
  if (faculty.manualOverride && faculty.overrideExpiry) {
    const expiry = new Date(faculty.overrideExpiry);
    if (now < expiry) {
      return { status: faculty.manualOverride };
    } else {
      // Override expired, clear it
      clearExpiredOverride(faculty.name);
    }
  }

  // Check if today is their weekend
  if (faculty.weekend?.includes(day)) {
    return { status: "on_weekend" };
  }

  // Check if now is in class time
  const classes = faculty.classTimes?.[day];
  if (Array.isArray(classes)) {
    for (const cls of classes) {
      if (cls.start < cls.end && timeStr >= cls.start && timeStr < cls.end) {
        return {
          status: "in_class",
          room: cls.room || null,
          batch: cls.batch || null
        };
      }
    }
  }

  // Check if now is within office hours
  const office = faculty.officeHours?.[day];
  if (Array.isArray(office) && office.length === 2) {
    const [start, end] = office;
    if (start < end && timeStr >= start && timeStr < end) {
      return { status: "at_dept" };
    }
  }

  return { status: "off_duty" };
}

async function clearExpiredOverride(name) {
  try {
    await facultyDB.updateFacultyOverride(name, null, null);
  } catch (error) {
    console.error("❌ Error clearing expired override:", error);
  }
}

async function updateStatuses() {
  try {
    const allFaculty = await facultyDB.getAllFaculty();
    
    for (const faculty of allFaculty) {
      const statusObj = getCurrentStatus(faculty);
      await facultyDB.updateFacultyStatus(faculty.name, statusObj);
    }
    
    console.log("✅ Auto status updated at", new Date().toISOString());
  } catch (error) {
    console.error("❌ Failed to auto-update statuses:", error);
  }
}

// Initialize everything
async function startup() {
  try {
    console.log("🚀 Starting Faculty Status Backend...");
    
    facultyDB = new FacultyDB();
    
    // Check for initial migration or file sync
    try {
      const db = await facultyDB.connect();
      const existingCount = await db.collection('faculty').countDocuments();
      
      if (existingCount === 0) {
        console.log("📦 Database is empty, performing initial migration...");
        await facultyDB.migrateFromJSON();
      } else {
        console.log(`✅ Database has ${existingCount} faculty records`);
        
        // Check if faculty.json exists and sync if needed
        const jsonPath = path.join(__dirname, "faculty.json");
        if (fs.existsSync(jsonPath)) {
          const lastSync = await facultyDB.getSetting('last_faculty_sync');
          if (!lastSync) {
            console.log("📄 Performing initial faculty.json sync...");
            await syncFacultyFromJSON();
            const jsonStat = fs.statSync(jsonPath);
            await facultyDB.setSetting('last_faculty_sync', jsonStat.mtime.toISOString());
          }
        }
      }
    } catch (error) {
      console.log("⚠️ Migration/sync check failed:", error.message);
    }
    
    // Start auto status updates
    updateStatuses();
    setInterval(updateStatuses, 3000);
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log("💾 Database: MongoDB Atlas (with file sync)");
      console.log("📄 Edit faculty.json or marquee.txt to update data");
      console.log("🟢 Status: Ready");
    });
  } catch (error) {
    console.error("💥 Startup failed:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  if (facultyDB) {
    await facultyDB.close();
  }
  process.exit(0);
});

startup();