const { MongoClient } = require('mongodb');

class FacultyDB {
  constructor() {
    this.client = new MongoClient(process.env.MONGODB_URI);
    this.db = null;
  }

  async connect() {
    if (!this.db) {
      await this.client.connect();
      this.db = this.client.db('faculty_status');
    }
    return this.db;
  }

  async getUsersCollection() {
    const db = await this.connect();
    return db.collection('users');
  }

  async listUsers() {
    const users = await this.getUsersCollection();
    return users.find({}).toArray();
  }

  async getUserByUsername(username) {
    if (!username) return null;
    const users = await this.getUsersCollection();
    return users.findOne({ username: username.toLowerCase() });
  }

  async getUserByFacultyName(facultyName) {
    if (!facultyName) return null;
    const users = await this.getUsersCollection();
    return users.findOne({ facultyName });
  }

  async upsertUser(user) {
    const users = await this.getUsersCollection();
    const username = user.username.toLowerCase();
    const now = new Date();
    const payload = {
      ...user,
      username,
      updatedAt: now
    };

    await users.updateOne(
      { username },
      {
        $set: payload,
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    return this.getUserByUsername(username);
  }

  async updateUser(username, updates) {
    const users = await this.getUsersCollection();
    const now = new Date();
    const result = await users.updateOne(
      { username: username.toLowerCase() },
      {
        $set: {
          ...updates,
          updatedAt: now
        }
      }
    );
    return result.modifiedCount > 0;
  }

  async deleteUser(username) {
    const users = await this.getUsersCollection();
    const result = await users.deleteOne({ username: username.toLowerCase() });
    return result.deletedCount > 0;
  }

  async ensureDefaultAdmin(defaultUser) {
    const users = await this.getUsersCollection();
    const existingAdmin = await users.findOne({ username: defaultUser.username.toLowerCase() });
    if (existingAdmin) return existingAdmin;

    const now = new Date();
    const adminUser = {
      ...defaultUser,
      username: defaultUser.username.toLowerCase(),
      role: 'admin',
      facultyName: defaultUser.facultyName || null,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
      lastPasswordChangeAt: now
    };

    await users.insertOne(adminUser);
    return adminUser;
  }

  async createFacultyUser(facultyName, userData) {
    const users = await this.getUsersCollection();
    const existing = await users.findOne({ facultyName });
    const now = new Date();
    const payload = {
      ...userData,
      username: userData.username.toLowerCase(),
      facultyName,
      updatedAt: now
    };

    if (existing) {
      await users.updateOne(
        { _id: existing._id },
        { $set: payload }
      );
      return this.getUserByUsername(payload.username);
    }

    await users.insertOne({
      ...payload,
      createdAt: now
    });

    return this.getUserByUsername(payload.username);
  }

  async getAllFaculty() {
    const db = await this.connect();
    const faculty = await db.collection('faculty').find({}).toArray();
    
    return faculty.map(f => ({
      name: f.name,
      designation: f.designation,
      contact: f.contact,
      email: f.email,
      image: f.image,
      weekend: f.weekend || [],
      officeHours: f.officeHours || {},
      classTimes: f.classTimes || {},
      status: f.status || "off_duty",
      manualOverride: f.manualOverride,
      overrideExpiry: f.overrideExpiry,
      precedence: f.precedence || 50  // ADD THIS LINE - this was missing!
    }));
  }

  async updateFacultyStatus(name, status) {
    const db = await this.connect();
    const result = await db.collection('faculty').updateOne(
      { name: name },
      { 
        $set: { 
          status: status,
          updatedAt: new Date()
        }
      }
    );
    return result.modifiedCount;
  }

  async updateFacultyOverride(name, manualOverride, overrideExpiry) {
    const db = await this.connect();
    const result = await db.collection('faculty').updateOne(
      { name: name },
      { 
        $set: { 
          manualOverride: manualOverride,
          overrideExpiry: overrideExpiry ? new Date(overrideExpiry) : null,
          updatedAt: new Date()
        }
      }
    );
    return result.modifiedCount;
  }

  async bulkUpdateOverrides(updates) {
    const db = await this.connect();
    const operations = updates.map(update => ({
      updateOne: {
        filter: { name: update.name },
        update: {
          $set: {
            manualOverride: update.manualOverride,
            overrideExpiry: update.overrideExpiry ? new Date(update.overrideExpiry) : null,
            updatedAt: new Date()
          }
        }
      }
    }));
    
    const result = await db.collection('faculty').bulkWrite(operations);
    return result.modifiedCount;
  }

  async getSetting(key) {
    const db = await this.connect();
    const setting = await db.collection('settings').findOne({ key: key });
    return setting ? setting.value : null;
  }

  async setSetting(key, value) {
    const db = await this.connect();
    const result = await db.collection('settings').updateOne(
      { key: key },
      { 
        $set: { 
          value: value,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    return result.modifiedCount;
  }

  async migrateFromJSON() {
    const fs = require('fs');
    const path = require('path');
    const jsonPath = path.join(__dirname, '../faculty.json');
    
    if (!fs.existsSync(jsonPath)) {
      console.log('No faculty.json found, skipping migration');
      return;
    }

    const db = await this.connect();
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    for (const faculty of jsonData) {
      await db.collection('faculty').updateOne(
        { name: faculty.name },
        {
          $set: {
            ...faculty,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    // Set default marquee
    await this.setSetting('marquee_text', 'Welcome to Faculty Status Display System');
    
    console.log(`✅ Migrated ${jsonData.length} faculty records from JSON to MongoDB`);
    
    // Backup JSON file
    try {
      fs.renameSync(jsonPath, jsonPath + '.backup');
      console.log('📁 Backed up faculty.json as faculty.json.backup');
    } catch (error) {
      console.log('⚠️ Could not backup faculty.json (file may not exist)');
    }
  }

  async updateFacultyPrecedence(name, precedence) {
    try {
      const db = await this.connect();
      const result = await db.collection('faculty').updateOne(
        { name: name },
        { 
          $set: { 
            precedence: precedence,
            updatedAt: new Date()
          }
        }
      );
      
      console.log(`Updated ${name} precedence to ${precedence}, matched: ${result.matchedCount}, modified: ${result.modifiedCount}`);
      return result.modifiedCount > 0;
    } catch (error) {
      console.error('Error updating faculty precedence:', error);
      throw error;
    }
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
  }
}

module.exports = FacultyDB;