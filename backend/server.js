const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const FacultyDB = require("./db/faculty");
const compression = require('compression');

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || "jwt_secret_key_change_in_production";
const JWT_EXPIRES_IN = "8h"; // 8 hours
const LEGACY_ADMIN_USERNAME = "admin";
const LEGACY_ADMIN_PASSWORD = "admin123";
const DEFAULT_TEMP_PASSWORD_LENGTH = 12;
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEY_LENGTH = 64;
const PBKDF2_DIGEST = "sha512";

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
let facultyDB;
let sessionStore;

// Allow frontend access
app.use(cors({
  origin: ["https://faculty-status-display.vercel.app", "http://localhost:3000"],
  credentials: true
}));
app.use(express.json({ 
  limit: '50mb',
  verify: (req, res, buf, encoding) => {
    // Add request size logging
    console.log(`Request size: ${buf.length} bytes`);
  }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(compression());

// Sessions - Temporary in-memory store until MongoDB connects
app.set("trust proxy", 1);

// Session configuration function (will be upgraded to MongoDB store after connection)
function createSessionConfig(store = null) {
  return {
    secret: process.env.SESSION_SECRET || "secret123",
    resave: false,
    saveUninitialized: false,
    rolling: true, // Renew session on every request
    store: store,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? "none" : "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours (longer than typical work session)
      httpOnly: true
    }
  };
}

// Start with memory store
app.use(session(createSessionConfig()));

// === MIDDLEWARE ===
// JWT Authentication middleware
function requireAuth(req, res, next) {
  // Check for token in Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "No token provided" });
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach user info to request
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  };
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeFacultyUsername(faculty) {
  const email = normalizeUsername(faculty?.email);
  if (email) {
    return email;
  }

  return normalizeUsername(faculty?.name).replace(/\s+/g, "");
}

function generateTempPassword(length = DEFAULT_TEMP_PASSWORD_LENGTH) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*";
  const bytes = crypto.randomBytes(length);
  let password = "";

  for (let index = 0; index < length; index += 1) {
    password += alphabet[bytes[index] % alphabet.length];
  }

  return password;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(
    String(password),
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST
  ).toString("hex");

  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") {
    return false;
  }

  const [scheme, iterationsStr, salt, hash] = storedHash.split("$");
  if (scheme !== "pbkdf2" || !iterationsStr || !salt || !hash) {
    return normalizeUsername(password) === LEGACY_ADMIN_PASSWORD && storedHash === LEGACY_ADMIN_PASSWORD;
  }

  const iterations = Number(iterationsStr);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  const candidate = crypto.pbkdf2Sync(
    String(password),
    salt,
    iterations,
    hash.length / 2,
    PBKDF2_DIGEST
  );

  const storedBuffer = Buffer.from(hash, "hex");
  if (storedBuffer.length !== candidate.length) {
    return false;
  }

  return crypto.timingSafeEqual(storedBuffer, candidate);
}

function buildAuthToken(user) {
  const payload = {
    username: user.username,
    role: user.role || "user",
    linkedFacultyName: user.linkedFacultyName || null,
    linkedFacultyEmail: user.linkedFacultyEmail || null,
    mustChangePassword: !!user.mustChangePassword,
    loginTime: new Date().toISOString()
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function normalizeUserRecord(user) {
  if (!user) {
    return null;
  }

  return {
    _id: user._id,
    username: user.username,
    usernameLower: user.usernameLower,
    role: user.role || "user",
    linkedFacultyName: user.linkedFacultyName || null,
    linkedFacultyEmail: user.linkedFacultyEmail || null,
    mustChangePassword: !!user.mustChangePassword,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    passwordUpdatedAt: user.passwordUpdatedAt || null
  };
}

async function getUsersCollection() {
  const db = await facultyDB.connect();
  return db.collection("users");
}

async function findUserByUsername(username) {
  const users = await getUsersCollection();
  return users.findOne({ usernameLower: normalizeUsername(username) });
}

async function issueAuthResponse(user, res) {
  const token = buildAuthToken(user);
  res.status(200).json({
    success: true,
    token,
    expiresIn: JWT_EXPIRES_IN,
    user: normalizeUserRecord(user)
  });
}

async function upsertUserFromFaculty(faculty, options = {}) {
  const users = await getUsersCollection();
  const baseUsername = normalizeFacultyUsername(faculty);
  if (!baseUsername) {
    return null;
  }

  const existing = await users.findOne({
    $or: [
      { linkedFacultyName: faculty.name },
      { usernameLower: baseUsername }
    ]
  });

  if (existing && !options.forceReset) {
    const updates = {
      linkedFacultyName: faculty.name || existing.linkedFacultyName || null,
      linkedFacultyEmail: faculty.email || existing.linkedFacultyEmail || null,
      updatedAt: new Date()
    };

    await users.updateOne({ _id: existing._id }, { $set: updates });
    return { user: { ...existing, ...updates }, tempPassword: null, created: false };
  }

  let username = baseUsername;
  let suffix = 1;
  while (await users.findOne({ usernameLower: normalizeUsername(username) })) {
    suffix += 1;
    username = `${baseUsername}${suffix}`;
  }

  const tempPassword = options.tempPassword || generateTempPassword();
  const now = new Date();
  const newUser = {
    username,
    usernameLower: normalizeUsername(username),
    passwordHash: hashPassword(tempPassword),
    role: options.role || "user",
    linkedFacultyName: faculty.name || null,
    linkedFacultyEmail: faculty.email || null,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
    passwordUpdatedAt: now
  };

  const result = await users.insertOne(newUser);
  return { user: { ...newUser, _id: result.insertedId }, tempPassword, created: true };
}

async function ensureDefaultUsersFromFaculty() {
  const db = await facultyDB.connect();
  const facultyRecords = await db.collection("faculty").find({}).toArray();
  const createdUsers = [];

  for (const faculty of facultyRecords) {
    const created = await upsertUserFromFaculty(faculty);
    if (created?.created) {
      createdUsers.push({
        username: created.user.username,
        tempPassword: created.tempPassword,
        linkedFacultyName: faculty.name,
        linkedFacultyEmail: faculty.email || null
      });
    }
  }

  return createdUsers;
}

// Serve images
app.use("/images", express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/ads", express.static(path.join(__dirname, "public/ads")));

// === SYNC FUNCTION ===
// Replace the existing syncFacultyFromJSON function with this:

async function syncFacultyFromJSON() {
  const jsonPath = path.join(__dirname, "faculty.json");
  
  if (!fs.existsSync(jsonPath)) {
    console.log('No faculty.json found for sync');
    return;
  }

  try {
    const db = await facultyDB.connect();
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    console.log(`📄 Found ${jsonData.length} faculty records in JSON file`);
    
    // Get existing faculty with their current overrides
    const existingFaculty = await db.collection('faculty').find({}).toArray();
    const existingNames = new Set(existingFaculty.map(f => f.name));
    const overrideMap = new Map();
    
    console.log(`💾 Found ${existingFaculty.length} existing faculty records in database`);
    
    // Preserve valid manual overrides
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
    
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const faculty of jsonData) {
      if (!faculty.name) {
        console.log('⚠️ Skipping faculty with no name');
        skippedCount++;
        continue;
      }
      
      const facultyData = {
        ...faculty,
        updatedAt: new Date()
      };
      
      // Preserve valid manual overrides if they exist
      if (overrideMap.has(faculty.name)) {
        const override = overrideMap.get(faculty.name);
        facultyData.manualOverride = override.manualOverride;
        facultyData.overrideExpiry = override.overrideExpiry;
      }
      
      if (existingNames.has(faculty.name)) {
        // Update existing faculty (preserve creation date)
        const result = await db.collection('faculty').updateOne(
          { name: faculty.name },
          { 
            $set: facultyData,
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: false }
        );
        
        if (result.modifiedCount > 0) {
          updatedCount++;
          console.log(`✅ Updated existing faculty: ${faculty.name}`);
        } else {
          skippedCount++;
        }
      } else {
        // Insert new faculty
        facultyData.createdAt = new Date();
        facultyData.status = faculty.status || "off_duty";
        
        await db.collection('faculty').insertOne(facultyData);
        insertedCount++;
        console.log(`➕ Inserted new faculty: ${faculty.name}`);
      }
    }
    
    console.log(`✅ Sync completed: ${insertedCount} inserted, ${updatedCount} updated, ${skippedCount} skipped`);
    
    // Final count check
    const finalCount = await db.collection('faculty').countDocuments();
    console.log(`📊 Total faculty in database: ${finalCount}`);
    
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
    
    // Get faculty data from database and sort consistently
    const faculty = await facultyDB.getAllFaculty();
    
    // Sort by precedence (lower numbers first), then by name
    const sortedFaculty = faculty.sort((a, b) => {
      const precedenceA = a.precedence || 50;
      const precedenceB = b.precedence || 50;
      
      if (precedenceA !== precedenceB) {
        return precedenceA - precedenceB;
      }
      return a.name.localeCompare(b.name);
    });
    
    console.log('Returning sorted faculty:', sortedFaculty.map(f => `${f.name} (precedence: ${f.precedence || 50})`));
    
    res.json(sortedFaculty);
  } catch (error) {
    console.error("❌ Error fetching faculty:", error);
    res.status(500).json({ error: "Failed to fetch faculty data" });
  }
});

async function handleLogin(req, res) {
  const { username, password } = req.body;
  const normalizedUsername = normalizeUsername(username);

  try {
    if (!normalizedUsername || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    if (normalizedUsername === LEGACY_ADMIN_USERNAME && password === LEGACY_ADMIN_PASSWORD) {
      const legacyAdmin = {
        username: LEGACY_ADMIN_USERNAME,
        usernameLower: LEGACY_ADMIN_USERNAME,
        role: "admin",
        linkedFacultyName: null,
        linkedFacultyEmail: null,
        mustChangePassword: true
      };
      return issueAuthResponse(legacyAdmin, res);
    }

    const user = await findUserByUsername(normalizedUsername);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const responseUser = normalizeUserRecord(user);
    responseUser.passwordHash = undefined;
    return issueAuthResponse(user, res);
  } catch (error) {
    console.error("❌ Login failed:", error);
    res.status(500).json({ error: "Failed to login" });
  }
}

app.post("/api/login", handleLogin);

app.post("/api/auth/login", handleLogin);

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await findUserByUsername(req.user.username);
    if (user) {
      return res.json({ loggedIn: true, user: normalizeUserRecord(user) });
    }

    return res.json({
      loggedIn: true,
      user: {
        username: req.user.username,
        role: req.user.role || "user",
        linkedFacultyName: req.user.linkedFacultyName || null,
        linkedFacultyEmail: req.user.linkedFacultyEmail || null,
        mustChangePassword: !!req.user.mustChangePassword
      }
    });
  } catch (error) {
    console.error("❌ Failed to load user profile:", error);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

app.get("/api/auth/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const users = await getUsersCollection();
    const records = await users.find({}).sort({ username: 1 }).toArray();
    res.json(records.map(normalizeUserRecord));
  } catch (error) {
    console.error("❌ Failed to list users:", error);
    res.status(500).json({ error: "Failed to list users" });
  }
});

app.put("/api/auth/users/:username", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const { role } = req.body;

    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    if (!["admin", "editor", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const users = await getUsersCollection();
    const result = await users.updateOne(
      { usernameLower: username },
      { $set: { role, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const updatedUser = await findUserByUsername(username);
    res.json({ message: "User role updated", user: normalizeUserRecord(updatedUser) });
  } catch (error) {
    console.error("❌ Failed to update user role:", error);
    res.status(500).json({ error: "Failed to update role" });
  }
});

app.post("/api/auth/users/:username/reset-password", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const tempPassword = generateTempPassword();
    const users = await getUsersCollection();
    await users.updateOne(
      { usernameLower: username },
      {
        $set: {
          passwordHash: hashPassword(tempPassword),
          mustChangePassword: true,
          updatedAt: new Date(),
          passwordUpdatedAt: new Date()
        }
      }
    );

    res.json({
      message: "Password reset successfully",
      username,
      temporaryPassword: tempPassword
    });
  } catch (error) {
    console.error("❌ Failed to reset password:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

app.post("/api/auth/migrate-faculty-accounts", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const db = await facultyDB.connect();
    const facultyRecords = await db.collection("faculty").find({}).toArray();
    const createdUsers = [];

    for (const faculty of facultyRecords) {
      const created = await upsertUserFromFaculty(faculty);
      if (created?.created) {
        createdUsers.push({
          facultyName: faculty.name,
          username: created.user.username,
          temporaryPassword: created.tempPassword
        });
      }
    }

    res.json({
      message: "Faculty accounts migrated",
      createdCount: createdUsers.length,
      createdUsers
    });
  } catch (error) {
    console.error("❌ Failed to migrate faculty accounts:", error);
    res.status(500).json({ error: "Failed to migrate faculty accounts" });
  }
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const username = normalizeUsername(req.user.username);

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const users = await getUsersCollection();
    let user = await findUserByUsername(username);

    if (!user && username === LEGACY_ADMIN_USERNAME && currentPassword === LEGACY_ADMIN_PASSWORD) {
      user = {
        username: LEGACY_ADMIN_USERNAME,
        usernameLower: LEGACY_ADMIN_USERNAME,
        role: "admin",
        linkedFacultyName: null,
        linkedFacultyEmail: null,
        mustChangePassword: true
      };
    }

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const passwordMatches = user.passwordHash
      ? verifyPassword(currentPassword, user.passwordHash)
      : currentPassword === LEGACY_ADMIN_PASSWORD && username === LEGACY_ADMIN_USERNAME;

    if (!passwordMatches) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const passwordHash = hashPassword(newPassword);
    await users.updateOne(
      { usernameLower: username },
      {
        $set: {
          username: username,
          usernameLower: username,
          role: user.role || req.user.role || "user",
          linkedFacultyName: user.linkedFacultyName || req.user.linkedFacultyName || null,
          linkedFacultyEmail: user.linkedFacultyEmail || req.user.linkedFacultyEmail || null,
          passwordHash,
          mustChangePassword: false,
          updatedAt: new Date(),
          passwordUpdatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("❌ Failed to change password:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

app.post("/api/update", requireAuth, async (req, res) => {
  const overrides = req.body;

  try {
    if (req.user.role === "user") {
      const allowedFacultyName = req.user.linkedFacultyName;
      if (!allowedFacultyName) {
        return res.status(403).json({ error: "No faculty account linked to this user" });
      }

      const invalidUpdate = Array.isArray(overrides)
        ? overrides.some(update => normalizeUsername(update.name) !== normalizeUsername(allowedFacultyName))
        : normalizeUsername(overrides.name) !== normalizeUsername(allowedFacultyName);

      if (invalidUpdate) {
        return res.status(403).json({ error: "Users can only update their own status" });
      }
    }

    const result = await facultyDB.bulkUpdateOverrides(overrides);
    console.log(`✅ Updated ${result} faculty records`);
    res.json({ message: "Faculty data updated successfully." });
  } catch (error) {
    console.error("❌ Error updating faculty:", error);
    res.status(500).json({ error: "Failed to update faculty data" });
  }
});

app.post("/api/logout", (req, res) => {
  // With JWT, logout is handled client-side by removing the token
  // No server-side session to destroy
  res.json({ success: true, message: "Logged out successfully" });
});

app.get("/api/check-login", requireAuth, async (req, res) => {
  try {
    const decoded = req.user;
    const user = await findUserByUsername(decoded.username);
    const sessionAge = decoded.loginTime ? Math.floor((Date.now() - new Date(decoded.loginTime)) / 1000 / 60) : null;
    const remainingMinutes = Math.floor((decoded.exp - Date.now() / 1000) / 60);
    
    res.json({ 
      loggedIn: true,
      sessionAge: sessionAge,
      remainingMinutes: remainingMinutes,
      user: user ? normalizeUserRecord(user) : {
        username: decoded.username,
        role: decoded.role || "user",
        linkedFacultyName: decoded.linkedFacultyName || null,
        linkedFacultyEmail: decoded.linkedFacultyEmail || null,
        mustChangePassword: !!decoded.mustChangePassword
      }
    });
  } catch (error) {
    res.status(401).json({ loggedIn: false, error: error.message });
  }
});

app.get("/api/ads", (req, res) => {
  const adsDir = path.join(__dirname, "public/ads");
  fs.readdir(adsDir, (err, files) => {
    if (err) return res.status(500).json({ error: "Failed to read ads directory" });
    const ads = files
      .filter(f => /\.(jpg|jpeg|png|gif|webp|mp4|webm)$/i.test(f))
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
app.post("/api/admin/faculty", requireAuth, requireRole("admin", "editor"), async (req, res) => {
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
    
    if (!newFaculty.name) {
      return res.status(400).json({ error: "Faculty name is required" });
    }

    // Check if faculty already exists
    const existing = await db.collection('faculty').findOne({ name: newFaculty.name });
    if (existing) {
      return res.status(400).json({ error: "Faculty with this name already exists" });
    }
    
    await db.collection('faculty').insertOne(newFaculty);
    await upsertUserFromFaculty(newFaculty, { role: "user" });
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
    const originalName = req.params.name;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };
    
    // Don't modify these fields
    delete updateData.status;
    delete updateData.manualOverride;
    delete updateData.overrideExpiry;
    delete updateData.createdAt;
    delete updateData._id;
    
    // Preserve precedence if not provided
    if (updateData.precedence === undefined) {
      const existing = await db.collection('faculty').findOne({ name: originalName });
      if (existing && existing.precedence !== undefined) {
        updateData.precedence = existing.precedence;
      }
    }
    
    console.log(`Updating faculty ${originalName} with precedence:`, updateData.precedence);
    
    // If name is being changed, check for duplicates
    if (updateData.name && updateData.name !== originalName) {
      const existing = await db.collection('faculty').findOne({ name: updateData.name });
      if (existing) {
        return res.status(400).json({ error: "Faculty with this name already exists" });
      }
    }

    if (req.user.role === "user") {
      if (normalizeUsername(originalName) !== normalizeUsername(req.user.linkedFacultyName)) {
        return res.status(403).json({ error: "Users can only edit their own faculty profile" });
      }

      const allowedFields = new Set(["name", "designation", "contact", "email", "image", "weekend", "officeHours", "classTimes", "displayPosition", "customPosition", "precedence"]);
      Object.keys(updateData).forEach(key => {
        if (!allowedFields.has(key)) {
          delete updateData[key];
        }
      });
    }
    
    const result = await db.collection('faculty').updateOne(
      { name: originalName },
      { $set: updateData }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Faculty not found" });
    }

    if (updateData.name && updateData.name !== originalName) {
      const users = await getUsersCollection();
      await users.updateOne(
        { linkedFacultyName: originalName },
        {
          $set: {
            linkedFacultyName: updateData.name,
            linkedFacultyEmail: updateData.email || null,
            updatedAt: new Date()
          }
        }
      );
    }
    
    console.log(`✅ Updated faculty: ${originalName} (precedence: ${updateData.precedence || 'default'})`);
    
    res.json({ message: "Faculty updated successfully" });
  } catch (error) {
    console.error("Error updating faculty:", error);
    res.status(500).json({ error: "Failed to update faculty" });
  }
});

// Delete faculty member
app.delete("/api/admin/faculty/:name", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const db = await facultyDB.connect();
    const result = await db.collection('faculty').deleteOne({ name: req.params.name });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Faculty not found" });
    }
    
    console.log(`✅ Deleted faculty: ${req.params.name}`);
    const users = await getUsersCollection();
    await users.deleteMany({ linkedFacultyName: req.params.name });
    res.json({ message: "Faculty deleted successfully" });
  } catch (error) {
    console.error("Error deleting faculty:", error);
    res.status(500).json({ error: "Failed to delete faculty" });
  }
});

// Update marquee text (database version for admin panel)
app.post("/api/admin/marquee", requireAuth, requireRole("admin", "editor"), async (req, res) => {
  const { text } = req.body;
  
  try {
    // Try to update the file directly first (if GitHub token is available)
    if (process.env.GITHUB_TOKEN) {
      try {
        const githubOwner = 'masud7866';
        const githubRepo = 'faculty-status-display';
        const filePath = 'backend/public/marquee.txt';

        // Check if file already exists to get SHA
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

        // Update/create file on GitHub
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
              message: `Update marquee text via admin panel`,
              content: Buffer.from(text, 'utf8').toString('base64'),
              sha: sha // Include SHA if file exists (for update)
            })
          }
        );

        if (uploadResponse.ok) {
          console.log("✅ Updated marquee.txt file on GitHub");
          
          // Also update local file if it exists
          const localMarqueePath = path.join(__dirname, "public/marquee.txt");
          try {
            fs.writeFileSync(localMarqueePath, text, 'utf8');
            console.log("✅ Updated local marquee.txt file");
          } catch (error) {
            console.log("⚠️ Could not update local file (that's okay):", error.message);
          }
          
          // Update database as backup
          await facultyDB.setSetting('marquee_text', text);
          
          return res.json({ 
            message: "Marquee text updated successfully in file and database",
            method: "file_and_database"
          });
        } else {
          const error = await uploadResponse.json();
          throw new Error(error.message || 'GitHub file update failed');
        }
      } catch (githubError) {
        console.log("⚠️ GitHub file update failed, falling back to local/database:", githubError.message);
      }
    }
    
    // Fallback: Try to update local file first
    const localMarqueePath = path.join(__dirname, "public/marquee.txt");
    try {
      // Ensure directory exists
      const dir = path.dirname(localMarqueePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(localMarqueePath, text, 'utf8');
      console.log("✅ Updated local marquee.txt file");
      
      // Also update database as backup
      await facultyDB.setSetting('marquee_text', text);
      
      res.json({ 
        message: "Marquee text updated successfully in local file and database",
        method: "local_file_and_database"
      });
    } catch (fileError) {
      console.log("⚠️ Local file update failed, updating database only:", fileError.message);
      
      // Last resort: database only
      await facultyDB.setSetting('marquee_text', text);
      console.log("✅ Updated marquee text in database only");
      res.json({ 
        message: "Marquee text updated in database (file update failed)",
        method: "database_only",
        warning: "File could not be updated. Changes may be overwritten if marquee.txt file exists."
      });
    }
  } catch (error) {
    console.error("❌ Error updating marquee:", error);
    res.status(500).json({ error: "Failed to update marquee text" });
  }
});

// GitHub file upload route
app.post("/api/upload", requireAuth, requireRole("admin", "editor"), async (req, res) => {
  const { filename, content, path } = req.body;
    if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "GitHub token not configured. Upload manually to GitHub." });
  }
  // Log payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
  console.log(`Upload payload size: ${payloadSize} bytes`);
  
  if (payloadSize > 45 * 1024 * 1024) { // 45MB safety margin
    return res.status(413).json({ 
      error: "File too large. Maximum size is 45MB after base64 encoding." 
    });
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
app.delete('/api/admin/ads/:filename', requireAuth, requireRole("admin", "editor"), async (req, res) => {
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
      const users = db.collection('users');
      await users.createIndex({ usernameLower: 1 }, { unique: true });
      await users.createIndex({ linkedFacultyName: 1 });
      const existingCount = await db.collection('faculty').countDocuments();
      
      console.log(`💾 Current database has ${existingCount} faculty records`);
      
      if (existingCount === 0) {
        console.log("📦 Database is empty, performing initial migration...");
        await facultyDB.migrateFromJSON();
      } else if (existingCount > 20) { // If we have way too many records
        console.log(`⚠️ Database has ${existingCount} records - this seems like duplicates`);
        console.log("🧹 Cleaning up duplicates...");
        
        // Get all faculty and remove duplicates by name
        const allFaculty = await db.collection('faculty').find({}).toArray();
        const uniqueNames = new Set();
        const duplicateIds = [];
        
        allFaculty.forEach(f => {
          if (uniqueNames.has(f.name)) {
            duplicateIds.push(f._id);
          } else {
            uniqueNames.add(f.name);
          }
        });
        
        if (duplicateIds.length > 0) {
          const deleteResult = await db.collection('faculty').deleteMany({
            _id: { $in: duplicateIds }
          });
          console.log(`🗑️ Removed ${deleteResult.deletedCount} duplicate records`);
        }
        
        const cleanCount = await db.collection('faculty').countDocuments();
        console.log(`✅ Database now has ${cleanCount} unique faculty records`);
      } else {
        // Normal sync check
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

      await ensureDefaultUsersFromFaculty();
    } catch (error) {
      console.log("⚠️ Migration/sync check failed:", error.message);
    }
    
    // Start auto status updates
    updateStatuses();
    setInterval(updateStatuses, 3000);
    
    // Upgrade to MongoDB session store (for persistence across restarts)
    try {
      sessionStore = MongoStore.create({
        client: facultyDB.client,
        dbName: 'faculty_status',
        collectionName: 'sessions',
        touchAfter: 2 * 60, // Touch session every 2 minutes (shorter than 3-min keep-alive)
        ttl: 8 * 60 * 60, // 8 hours TTL (matches cookie maxAge)
        autoRemove: 'native',
        crypto: {
          secret: process.env.SESSION_SECRET || 'secret123'
        }
      });
      
      // Reconfigure session middleware to use MongoDB store
      app.use(session(createSessionConfig(sessionStore)));

      console.log("🔐 Session store upgraded to MongoDB (persistent, 8-hour sessions)");
      console.log("   - Touch interval: 2 minutes (syncs with keep-alive)");
      console.log("   - Session TTL: 8 hours");
    } catch (error) {
      console.log("⚠️ MongoDB session store setup failed, using memory store:", error.message);
      console.log("   Sessions will work but won't persist across server restarts");
    }
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log("💾 Database: MongoDB Atlas (with file sync)");
      console.log("🔐 Sessions: " + (sessionStore ? "Persistent (MongoDB)" : "Memory (temporary)"));
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
  
  // Close session store
  if (sessionStore) {
    await sessionStore.close();
    console.log('🔐 Session store closed');
  }
  
  // Close database
  if (facultyDB) {
    await facultyDB.close();
  }
  process.exit(0);
});

startup();