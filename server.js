const express = require('express');
const oracledb = require('oracledb');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const path = require('path');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'zain-support-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Configure Oracle DB timeout settings
oracledb.connectionClass = 'POOLED';
oracledb.poolMax = 10;
oracledb.poolMin = 2;
oracledb.getConnectionTimeout = 120; // Increased to 120 seconds

// Middleware
app.use(cors());
app.use(express.json());

// Route to serve the main page (requires authentication) - BEFORE static middleware
app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public'));

// Authentication Middleware
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
  }
  next();
}

// Oracle Database Configuration
const dbConfig = {
  user: process.env.DB_USER || 'CBS_DB_OPSUPP',
  password: process.env.DB_PASSWORD || 'CBS_DB_OPSUPP',
  connectString: `${process.env.DB_HOST || '172.168.101.238'}:${process.env.DB_PORT || 1521}/${process.env.DB_SERVICE || 'PDB1'}`
};

// Email Configuration
const emailConfig = {
  service: 'Gmail',
  auth: {
    user: 'devgmf98@gmail.com',
    pass: 'jbjgmbtxsekbrzvx'
  }
};

// Initialize email transporter
const transporter = nodemailer.createTransport(emailConfig);

// Initialize restricted numbers cache
let restrictedNumbersCache = ['9123', '91211', '918', '9121', '9122'];

// Initialize restricted statuses cache
let restrictedStatusesCache = [];

// Initialize restricted categories cache
let restrictedCategoriesCache = [];

// Helper: normalize numbers to digits-only and match prefixes considering common variants
function normalizeNumber(s) {
  return s ? s.toString().replace(/[^0-9]/g, '') : '';
}

function matchesPrefix(target, prefix) {
  const t = normalizeNumber(target);
  const p = normalizeNumber(prefix);
  if (!t || !p) return false;
  const variants = [p, '0' + p, '92' + p, '0092' + p];
  return variants.some(v => t.startsWith(v));
}

// New: exact-match check (normalize and match common country/leading variants)
function matchesExact(target, prefix) {
  const t = normalizeNumber(target);
  const p = normalizeNumber(prefix);
  if (!t || !p) return false;
  const variants = [p, '0' + p, '92' + p, '0092' + p];
  return variants.some(v => t === v);
}

/**
 * Log failed mobile number update
 */
async function logFailedNumber(connection, mobileNumber, failureReason, username) {
  try {
    console.log(`[${new Date().toISOString()}] 📝 CALL: logFailedNumber(${mobileNumber}, "${failureReason}", ${username})`);
    
    if (!connection) {
      console.error(`[${new Date().toISOString()}] ✗ ERROR: No connection available for logging`);
      return false;
    }

    // Step 1: Get next sequence value
    console.log(`[${new Date().toISOString()}]    Step 1: Getting next ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ value...`);
    let nextId;
    try {
      const seqQuery = `SELECT ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ.NEXTVAL FROM dual`;
      const seqResult = await connection.execute(seqQuery);
      nextId = seqResult.rows[0][0];
      console.log(`[${new Date().toISOString()}]    ✓ Got sequence value: ${nextId}`);
    } catch (seqErr) {
      console.error(`[${new Date().toISOString()}]    ✗ Sequence error: ${seqErr.message}`);
      // Try to create the sequence if it doesn't exist
      try {
        console.log(`[${new Date().toISOString()}]    Attempting to create sequence...`);
        await connection.execute(`CREATE SEQUENCE ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ START WITH 1 INCREMENT BY 1`);
        const seqRetry = await connection.execute(`SELECT ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ.NEXTVAL FROM dual`);
        nextId = seqRetry.rows[0][0];
        console.log(`[${new Date().toISOString()}]    ✓ Created sequence and got value: ${nextId}`);
      } catch (createErr) {
        console.error(`[${new Date().toISOString()}]    ✗ Could not create sequence: ${createErr.message}`);
        return false;
      }
    }

    // Step 2: Insert the failed record
    console.log(`[${new Date().toISOString()}]    Step 2: Inserting failed number record...`);
    const insertQuery = `
      INSERT INTO ZAIN_SUPPORT_FAILED_NUM_LOGS 
      (LOG_ID, MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT)
      VALUES (:logId, :mobileNumber, :failureReason, :username, SYSDATE)
    `;
    
    const result = await connection.execute(insertQuery, {
      logId: nextId,
      mobileNumber: String(mobileNumber || '').trim().substring(0, 50),
      failureReason: String(failureReason || '').trim().substring(0, 500),
      username: String(username || '').trim().substring(0, 50)
    }, { autoCommit: true });
    
    console.log(`[${new Date().toISOString()}] ✅ SUCCESS: Logged failed number ${mobileNumber} (ID: ${nextId})`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ FAILED: logFailedNumber ERROR`);
    console.error(`[${new Date().toISOString()}]    Mobile: ${mobileNumber}`);
    console.error(`[${new Date().toISOString()}]    Reason: ${failureReason || 'unknown'}`);
    console.error(`[${new Date().toISOString()}]    Error Message: ${err.message}`);
    console.error(`[${new Date().toISOString()}]    Error Code: ${err.errorNum || 'N/A'}`);
    return false;
  }
}

/**
 * Log failed SIM update
 */
async function logFailedSim(connection, simIdentifier, failureReason, username) {
  try {
    console.log(`[${new Date().toISOString()}] 📝 CALL: logFailedSim(${simIdentifier}, "${failureReason}", ${username})`);
    
    if (!connection) {
      console.error(`[${new Date().toISOString()}] ✗ ERROR: No connection available for logging`);
      return false;
    }

    // Step 1: Get next sequence value
    console.log(`[${new Date().toISOString()}]    Step 1: Getting next ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ value...`);
    let nextId;
    try {
      const seqQuery = `SELECT ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ.NEXTVAL FROM dual`;
      const seqResult = await connection.execute(seqQuery);
      nextId = seqResult.rows[0][0];
      console.log(`[${new Date().toISOString()}]    ✓ Got sequence value: ${nextId}`);
    } catch (seqErr) {
      console.error(`[${new Date().toISOString()}]    ✗ Sequence error: ${seqErr.message}`);
      // Try to create the sequence if it doesn't exist
      try {
        console.log(`[${new Date().toISOString()}]    Attempting to create sequence...`);
        await connection.execute(`CREATE SEQUENCE ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ START WITH 1 INCREMENT BY 1`);
        const seqRetry = await connection.execute(`SELECT ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ.NEXTVAL FROM dual`);
        nextId = seqRetry.rows[0][0];
        console.log(`[${new Date().toISOString()}]    ✓ Created sequence and got value: ${nextId}`);
      } catch (createErr) {
        console.error(`[${new Date().toISOString()}]    ✗ Could not create sequence: ${createErr.message}`);
        return false;
      }
    }

    // Step 2: Insert the failed record
    console.log(`[${new Date().toISOString()}]    Step 2: Inserting failed SIM record...`);
    const insertQuery = `
      INSERT INTO ZAIN_SUPPORT_FAILED_SIM_LOGS 
      (LOG_ID, SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT)
      VALUES (:logId, :simIdentifier, :failureReason, :username, SYSDATE)
    `;
    
    const result = await connection.execute(insertQuery, {
      logId: nextId,
      simIdentifier: String(simIdentifier || '').trim().substring(0, 50),
      failureReason: String(failureReason || '').trim().substring(0, 500),
      username: String(username || '').trim().substring(0, 50)
    }, { autoCommit: true });
    
    console.log(`[${new Date().toISOString()}] ✅ SUCCESS: Logged failed SIM ${simIdentifier} (ID: ${nextId})`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ FAILED: logFailedSim ERROR`);
    console.error(`[${new Date().toISOString()}]    SIM: ${simIdentifier}`);
    console.error(`[${new Date().toISOString()}]    Reason: ${failureReason || 'unknown'}`);
    console.error(`[${new Date().toISOString()}]    Error Message: ${err.message}`);
    console.error(`[${new Date().toISOString()}]    Error Code: ${err.errorNum || 'N/A'}`);
    return false;
  }
}

// Test email configuration on startup
async function testEmailConfig() {
  try {
    console.log(`[${new Date().toISOString()}] Testing email configuration...`);
    console.log(`[${new Date().toISOString()}] Email Config: Service=${emailConfig.service}, User=${emailConfig.auth.user}`);
    
    await transporter.verify();
    console.log(`[${new Date().toISOString()}] ✓ Email configuration verified successfully!`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Email configuration warning:`, err.message);
    console.log(`[${new Date().toISOString()}] Server will continue running. Email notifications may not work.`);
    console.log(`[${new Date().toISOString()}] Check /api/test-email endpoint for detailed diagnostics.`);
    return false;
  }
}

// Function to send email notification to all registered recipients
async function sendEmailNotification(subject, htmlContent) {
  let connection;
  
  try {
    connection = await connectionPool.getConnection();
    
    // Check if email sending is enabled
    const settingQuery = `SELECT SETTING_VALUE FROM APP_SETTINGS WHERE SETTING_KEY = 'EMAIL_SENDING_ENABLED'`;
    const settingResult = await connection.execute(settingQuery);
    
    const emailEnabled = settingResult.rows.length > 0 ? 
      settingResult.rows[0][0].toLowerCase() === 'true' : 
      true; // Default to true if setting not found
    
    if (!emailEnabled) {
      console.log(`[${new Date().toISOString()}] ℹ️  Email sending is disabled. Skipping notification.`);
      return false;
    }
    
    // Fetch all recipient emails from database
    const query = `SELECT EMAIL FROM RECIPIENT_EMAILS ORDER BY EMAIL`;
    const result = await connection.execute(query);
    
    const recipients = result.rows.map(row => row[0]);
    
    // If no recipients found, log warning and return
    if (recipients.length === 0) {
      console.warn(`[${new Date().toISOString()}] ⚠️  No recipient emails configured. Skipping email notification.`);
      console.warn(`[${new Date().toISOString()}] Please add recipient emails in Settings > Email Recipients`);
      return false;
    }
    
    const mailOptions = {
      from: 'devgmf98@gmail.com',
      to: recipients.join(','),
      subject: subject,
      html: htmlContent
    };

    console.log(`[${new Date().toISOString()}] Attempting to send email to ${recipients.length} recipient(s): ${recipients.join(', ')}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[${new Date().toISOString()}] ✓ Email sent successfully to ${recipients.length} recipient(s)`);
    console.log(`[${new Date().toISOString()}] Response:`, info.response);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to send email to recipients`);
    console.error(`[${new Date().toISOString()}] Error details:`, err.message);
    console.error(`[${new Date().toISOString()}] Please verify:
      1. App Password is correct (run /api/test-email for diagnostics)
      2. 2-Step Verification is enabled on Gmail account
      3. Email configuration in .env is correct
      4. Firewall allows SMTP on port 587`);
    return false;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
  }
}

// Initialize Oracle connection pool
let connectionPool;
let poolRetries = 0;
const MAX_RETRIES = 3;

async function createUsersTable() {
  let connection;
  try {
    if (!connectionPool) {
      console.log('[' + new Date().toISOString() + '] Connection pool not ready for table creation');
      return;
    }

    connection = await connectionPool.getConnection();
    
    // Check if table exists
    const checkTableQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAINSUPPORTUSERS'`;
    const tableCheckResult = await connection.execute(checkTableQuery);
    
    if (tableCheckResult.rows.length > 0) {
      console.log('[' + new Date().toISOString() + '] ZAINSUPPORTUSERS table already exists');
      await connection.close();
      return;
    }

    // Create table
    const createTableQuery = `
      CREATE TABLE ZAINSUPPORTUSERS (
        USER_ID NUMBER PRIMARY KEY,
        USERNAME VARCHAR2(50) UNIQUE NOT NULL,
        PASSWORD VARCHAR2(255) NOT NULL,
        ROLE VARCHAR2(20) NOT NULL,
        ACTIVE NUMBER(1) DEFAULT 1,
        CREATED_AT TIMESTAMP DEFAULT SYSDATE
      )
    `;

    // Create sequence for USER_ID
    const createSequenceQuery = `CREATE SEQUENCE ZAINSUPPORTUSERS_SEQ START WITH 1 INCREMENT BY 1`;
    
    try {
      await connection.execute(createSequenceQuery);
    } catch (err) {
      // Sequence might already exist, ignore error
    }

    await connection.execute(createTableQuery);
    console.log('[' + new Date().toISOString() + '] ✓ ZAINSUPPORTUSERS table created successfully');

    // Now create initial users
    await createInitialUsers(connection);

    await connection.close();
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error creating users table:', err.message);
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
  }
}

async function createLoggingTables() {
  let connection;
  try {
    if (!connectionPool) {
      console.log('[' + new Date().toISOString() + '] Connection pool not ready for logging table creation');
      return;
    }

    connection = await connectionPool.getConnection();

    // Create number logs table
    const checkNumLogsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAINSUPPORTNUMLOGS'`;
    const numLogsCheckResult = await connection.execute(checkNumLogsQuery);
    
    if (numLogsCheckResult.rows.length === 0) {
      const createNumLogsQuery = `
        CREATE TABLE ZAINSUPPORTNUMLOGS (
          LOG_ID NUMBER PRIMARY KEY,
          MOBILE_NUMBER VARCHAR2(50) NOT NULL,
          STATUS_BEFORE VARCHAR2(10),
          STATUS_AFTER VARCHAR2(10) NOT NULL,
          USERNAME VARCHAR2(50) NOT NULL,
          UPDATE_TIME TIMESTAMP DEFAULT SYSDATE,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createNumLogsSeqQuery = `CREATE SEQUENCE ZAINSUPPORTNUMLOGS_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createNumLogsSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createNumLogsQuery);
      console.log('[' + new Date().toISOString() + '] ✓ ZAINSUPPORTNUMLOGS table created successfully');
    }

    // Create SIM logs table
    const checkSimLogsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_SIMS_LOGS'`;
    const simLogsCheckResult = await connection.execute(checkSimLogsQuery);
    
    if (simLogsCheckResult.rows.length === 0) {
      const createSimLogsQuery = `
        CREATE TABLE ZAIN_SUPPORT_SIMS_LOGS (
          LOG_ID NUMBER PRIMARY KEY,
          SIM_IDENTIFIER VARCHAR2(50) NOT NULL,
          STATUS_BEFORE VARCHAR2(10),
          STATUS_AFTER VARCHAR2(10) NOT NULL,
          USERNAME VARCHAR2(50) NOT NULL,
          UPDATE_TIME TIMESTAMP DEFAULT SYSDATE,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createSimLogsSeqQuery = `CREATE SEQUENCE ZAIN_SUPPORT_SIMS_LOGS_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createSimLogsSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createSimLogsQuery);
      console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_SIMS_LOGS table created successfully');
    }

    // Create failed numbers logs table
    const checkFailedNumLogsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_NUM_LOGS'`;
    const failedNumLogsCheckResult = await connection.execute(checkFailedNumLogsQuery);
    
    if (failedNumLogsCheckResult.rows.length === 0) {
      console.log('[' + new Date().toISOString() + '] Creating ZAIN_SUPPORT_FAILED_NUM_LOGS table...');
      
      // Create sequence first
      const createFailedNumLogsSeqQuery = `CREATE SEQUENCE ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ START WITH 1 INCREMENT BY 1`;
      try {
        await connection.execute(createFailedNumLogsSeqQuery);
        console.log('[' + new Date().toISOString() + '] ✓ Created ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ');
      } catch (seqErr) {
        console.log('[' + new Date().toISOString() + '] Sequence might already exist: ' + seqErr.message);
      }

      // Create table with proper sequence binding
      const createFailedNumLogsQuery = `
        CREATE TABLE ZAIN_SUPPORT_FAILED_NUM_LOGS (
          LOG_ID NUMBER PRIMARY KEY,
          MOBILE_NUMBER VARCHAR2(50) NOT NULL,
          FAILURE_REASON VARCHAR2(500) NOT NULL,
          USERNAME VARCHAR2(50) NOT NULL,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      try {
        await connection.execute(createFailedNumLogsQuery);
        console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_FAILED_NUM_LOGS table created successfully');
        
        // Create trigger for auto-increment
        const triggerQuery = `
          CREATE OR REPLACE TRIGGER ZAIN_SUPPORT_FAILED_NUM_LOGS_TRG
          BEFORE INSERT ON ZAIN_SUPPORT_FAILED_NUM_LOGS
          FOR EACH ROW
          BEGIN
            IF :new.LOG_ID IS NULL THEN
              SELECT ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ.NEXTVAL INTO :new.LOG_ID FROM dual;
            END IF;
          END;
        `;
        try {
          await connection.execute(triggerQuery);
          console.log('[' + new Date().toISOString() + '] ✓ Created auto-increment trigger for ZAIN_SUPPORT_FAILED_NUM_LOGS');
        } catch (trigErr) {
          console.log('[' + new Date().toISOString() + '] Could not create trigger: ' + trigErr.message);
        }
      } catch (tableErr) {
        console.error('[' + new Date().toISOString() + '] Error creating ZAIN_SUPPORT_FAILED_NUM_LOGS table:', tableErr.message);
      }
    } else {
      console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_FAILED_NUM_LOGS table already exists');
    }

    // Create failed SIM logs table
    const checkFailedSimLogsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_SIM_LOGS'`;
    const failedSimLogsCheckResult = await connection.execute(checkFailedSimLogsQuery);
    
    if (failedSimLogsCheckResult.rows.length === 0) {
      console.log('[' + new Date().toISOString() + '] Creating ZAIN_SUPPORT_FAILED_SIM_LOGS table...');
      
      // Create sequence first
      const createFailedSimLogsSeqQuery = `CREATE SEQUENCE ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ START WITH 1 INCREMENT BY 1`;
      try {
        await connection.execute(createFailedSimLogsSeqQuery);
        console.log('[' + new Date().toISOString() + '] ✓ Created ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ');
      } catch (seqErr) {
        console.log('[' + new Date().toISOString() + '] Sequence might already exist: ' + seqErr.message);
      }

      // Create table with proper sequence binding
      const createFailedSimLogsQuery = `
        CREATE TABLE ZAIN_SUPPORT_FAILED_SIM_LOGS (
          LOG_ID NUMBER PRIMARY KEY,
          SIM_IDENTIFIER VARCHAR2(50) NOT NULL,
          FAILURE_REASON VARCHAR2(500) NOT NULL,
          USERNAME VARCHAR2(50) NOT NULL,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      try {
        await connection.execute(createFailedSimLogsQuery);
        console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_FAILED_SIM_LOGS table created successfully');
        
        // Create trigger for auto-increment
        const triggerQuery = `
          CREATE OR REPLACE TRIGGER ZAIN_SUPPORT_FAILED_SIM_LOGS_TRG
          BEFORE INSERT ON ZAIN_SUPPORT_FAILED_SIM_LOGS
          FOR EACH ROW
          BEGIN
            IF :new.LOG_ID IS NULL THEN
              SELECT ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ.NEXTVAL INTO :new.LOG_ID FROM dual;
            END IF;
          END;
        `;
        try {
          await connection.execute(triggerQuery);
          console.log('[' + new Date().toISOString() + '] ✓ Created auto-increment trigger for ZAIN_SUPPORT_FAILED_SIM_LOGS');
        } catch (trigErr) {
          console.log('[' + new Date().toISOString() + '] Could not create trigger: ' + trigErr.message);
        }
      } catch (tableErr) {
        console.error('[' + new Date().toISOString() + '] Error creating ZAIN_SUPPORT_FAILED_SIM_LOGS table:', tableErr.message);
      }
    } else {
      console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_FAILED_SIM_LOGS table already exists');
    }

    // Create email logs table
    const checkMailLogsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAINSUPPORTMAIL'`;
    const mailLogsCheckResult = await connection.execute(checkMailLogsQuery);
    
    if (mailLogsCheckResult.rows.length === 0) {
      const createMailLogsQuery = `
        CREATE TABLE ZAINSUPPORTMAIL (
          MAIL_ID NUMBER PRIMARY KEY,
          RECIPIENT VARCHAR2(100) NOT NULL,
          SUBJECT VARCHAR2(255) NOT NULL,
          EMAIL_TYPE VARCHAR2(50) NOT NULL,
          TRIGGERED_BY VARCHAR2(50) NOT NULL,
          EMAIL_CONTENT CLOB,
          STATUS VARCHAR2(20) DEFAULT 'sent',
          SENT_AT TIMESTAMP DEFAULT SYSDATE,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createMailLogsSeqQuery = `CREATE SEQUENCE ZAINSUPPORTMAIL_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createMailLogsSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createMailLogsQuery);
      console.log('[' + new Date().toISOString() + '] ✓ ZAINSUPPORTMAIL table created successfully');
    }

    // Create restricted numbers table
    const checkRestrictedQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_NUMBERS_PREFIX'`;
    const restrictedCheckResult = await connection.execute(checkRestrictedQuery);
    
    if (restrictedCheckResult.rows.length === 0) {
      const createRestrictedQuery = `
        CREATE TABLE RESTRICTED_NUMBERS_PREFIX (
          PREFIX_ID NUMBER PRIMARY KEY,
          PREFIX VARCHAR2(50) NOT NULL UNIQUE,
          DESCRIPTION VARCHAR2(255),
          CREATED_BY VARCHAR2(50) NOT NULL,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createRestrictedSeqQuery = `CREATE SEQUENCE RESTRICTED_NUMBERS_PREFIX_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createRestrictedSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createRestrictedQuery);
      console.log('[' + new Date().toISOString() + '] ✓ RESTRICTED_NUMBERS_PREFIX table created successfully');

      // Insert default restricted numbers
      const insertDefaultQuery = `
        INSERT INTO RESTRICTED_NUMBERS_PREFIX (PREFIX_ID, PREFIX, DESCRIPTION, CREATED_BY)
        VALUES (RESTRICTED_NUMBERS_PREFIX_SEQ.NEXTVAL, :prefix, :description, 'system')
      `;

      const defaultPrefixes = ['9123', '91211', '918', '9121', '9122'];
      for (const prefix of defaultPrefixes) {
        try {
          await connection.execute(insertDefaultQuery, 
            { prefix: prefix, description: 'Default restricted prefix' }, 
            { autoCommit: true }
          );
        } catch (err) {
          // Might already exist
        }
      }
      console.log('[' + new Date().toISOString() + '] ✓ Default restricted prefixes inserted');
    }

    // Create recipient emails table
    const checkEmailsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RECIPIENT_EMAILS'`;
    const emailsCheckResult = await connection.execute(checkEmailsQuery);
    
    if (emailsCheckResult.rows.length === 0) {
      const createEmailsQuery = `
        CREATE TABLE RECIPIENT_EMAILS (
          EMAIL_ID NUMBER PRIMARY KEY,
          EMAIL VARCHAR2(100) NOT NULL UNIQUE,
          DESCRIPTION VARCHAR2(255),
          ADDED_BY VARCHAR2(50) NOT NULL,
          ADDED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createEmailsSeqQuery = `CREATE SEQUENCE RECIPIENT_EMAILS_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createEmailsSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createEmailsQuery);
      console.log('[' + new Date().toISOString() + '] ✓ RECIPIENT_EMAILS table created successfully');
    }

    // Create settings table
    const checkSettingsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'APP_SETTINGS'`;
    const settingsCheckResult = await connection.execute(checkSettingsQuery);
    
    if (settingsCheckResult.rows.length === 0) {
      const createSettingsQuery = `
        CREATE TABLE APP_SETTINGS (
          SETTING_ID NUMBER PRIMARY KEY,
          SETTING_KEY VARCHAR2(100) NOT NULL UNIQUE,
          SETTING_VALUE VARCHAR2(255) NOT NULL,
          SETTING_TYPE VARCHAR2(50),
          DESCRIPTION VARCHAR2(255),
          UPDATED_BY VARCHAR2(50),
          UPDATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createSettingsSeqQuery = `CREATE SEQUENCE APP_SETTINGS_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createSettingsSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createSettingsQuery);
      console.log('[' + new Date().toISOString() + '] ✓ APP_SETTINGS table created successfully');

      // Insert default settings
      const insertSettingQuery = `
        INSERT INTO APP_SETTINGS (SETTING_ID, SETTING_KEY, SETTING_VALUE, SETTING_TYPE, DESCRIPTION, UPDATED_BY)
        VALUES (APP_SETTINGS_SEQ.NEXTVAL, :settingKey, :settingValue, :settingType, :description, 'system')
      `;

      try {
        await connection.execute(insertSettingQuery, 
          { 
            settingKey: 'EMAIL_SENDING_ENABLED',
            settingValue: 'true',
            settingType: 'boolean',
            description: 'Enable or disable email notifications'
          }, 
          { autoCommit: true }
        );
      } catch (err) {
        // Might already exist
      }

      try {
        await connection.execute(insertSettingQuery, 
          { 
            settingKey: 'QUESTIONS_ENABLED',
            settingValue: 'true',
            settingType: 'boolean',
            description: 'Enable or disable support questions'
          }, 
          { autoCommit: true }
        );
      } catch (err) {
        // Might already exist
      }
      console.log('[' + new Date().toISOString() + '] ✓ Default settings inserted');
    }

    // Create restricted statuses table
    const checkRestrictedStatusesQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_STATUSES'`;
    const restrictedStatusesCheckResult = await connection.execute(checkRestrictedStatusesQuery);
    
    if (restrictedStatusesCheckResult.rows.length === 0) {
      const createRestrictedStatusesQuery = `
        CREATE TABLE RESTRICTED_STATUSES (
          STATUS_ID NUMBER PRIMARY KEY,
          STATUS_V VARCHAR2(50) NOT NULL UNIQUE,
          DESCRIPTION VARCHAR2(255),
          CREATED_BY VARCHAR2(50) NOT NULL,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createStatusSeqQuery = `CREATE SEQUENCE RESTRICTED_STATUSES_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createStatusSeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createRestrictedStatusesQuery);
      console.log('[' + new Date().toISOString() + '] ✓ RESTRICTED_STATUSES table created successfully');
    }

    // Create cache for restricted statuses
    const statusQuery = `SELECT STATUS_V FROM RESTRICTED_STATUSES ORDER BY STATUS_V`;
    const statusResult = await connection.execute(statusQuery);
    restrictedStatusesCache = statusResult.rows.map(row => row[0]);
    console.log('[' + new Date().toISOString() + '] Loaded restricted statuses into cache:', restrictedStatusesCache);

    // Create restricted categories table
    const checkRestrictedCategoriesQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_NUMBERS_CATEGORY'`;
    const restrictedCategoriesCheckResult = await connection.execute(checkRestrictedCategoriesQuery);
    
    if (restrictedCategoriesCheckResult.rows.length === 0) {
      const createRestrictedCategoriesQuery = `
        CREATE TABLE RESTRICTED_NUMBERS_CATEGORY (
          CATEGORY_ID NUMBER PRIMARY KEY,
          CATEGORY_CODE_V VARCHAR2(50) NOT NULL UNIQUE,
          DESCRIPTION VARCHAR2(255),
          CREATED_BY VARCHAR2(50) NOT NULL,
          CREATED_AT TIMESTAMP DEFAULT SYSDATE
        )
      `;

      const createCategorySeqQuery = `CREATE SEQUENCE RESTRICTED_NUMBERS_CATEGORY_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createCategorySeqQuery);
      } catch (err) {
        // Sequence might already exist
      }

      await connection.execute(createRestrictedCategoriesQuery);
      console.log('[' + new Date().toISOString() + '] ✓ RESTRICTED_NUMBERS_CATEGORY table created successfully');
    }

    // Create cache for restricted categories
    const categoryQuery = `SELECT CATEGORY_CODE_V FROM RESTRICTED_NUMBERS_CATEGORY ORDER BY CATEGORY_CODE_V`;
    const categoryResult = await connection.execute(categoryQuery);
    restrictedCategoriesCache = categoryResult.rows.map(row => row[0]);
    console.log('[' + new Date().toISOString() + '] Loaded restricted categories into cache:', restrictedCategoriesCache);

    console.log('[' + new Date().toISOString() + '] Checking support tables...');
    
    // Create support questions table
    const checkSupportQuestionsQuery = `SELECT table_name FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_ASKED_QUESTIONS'`;
    const supportQuestionsCheckResult = await connection.execute(checkSupportQuestionsQuery);
    
    if (supportQuestionsCheckResult.rows.length === 0) {
      console.log('[' + new Date().toISOString() + '] Creating ZAIN_SUPPORT_ASKED_QUESTIONS table...');
      const createSupportQuestionsQuery = `
        CREATE TABLE ZAIN_SUPPORT_ASKED_QUESTIONS (
          QUESTION_ID NUMBER PRIMARY KEY,
          TITLE VARCHAR2(255) NOT NULL,
          DESCRIPTION CLOB NOT NULL,
          ASKED_BY VARCHAR2(50) NOT NULL,
          ASKED_AT TIMESTAMP DEFAULT SYSDATE,
          STATUS VARCHAR2(20) DEFAULT 'OPEN'
        )
      `;

      const createQuestionSeqQuery = `CREATE SEQUENCE ZAIN_SUPPORT_ASKED_QUESTIONS_SEQ START WITH 1 INCREMENT BY 1`;
      
      try {
        await connection.execute(createQuestionSeqQuery);
        console.log('[' + new Date().toISOString() + '] ✓ Created ZAIN_SUPPORT_ASKED_QUESTIONS_SEQ sequence');
      } catch (err) {
        console.log('[' + new Date().toISOString() + '] Sequence may already exist:', err.message);
      }

      try {
        await connection.execute(createSupportQuestionsQuery);
        console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_ASKED_QUESTIONS table created successfully');
      } catch (err) {
        console.error('[' + new Date().toISOString() + '] Error creating ZAIN_SUPPORT_ASKED_QUESTIONS:', err.message);
      }
    } else {
      console.log('[' + new Date().toISOString() + '] ✓ ZAIN_SUPPORT_ASKED_QUESTIONS table already exists');
    }

    // Create support replies table - DROP and recreate to fix FK constraints
    const checkSupportRepliesQuery = `SELECT table_name FROM user_tables WHERE table_name = 'SUPPORT_REPLIES'`;
    const supportRepliesCheckResult = await connection.execute(checkSupportRepliesQuery);
    
    if (supportRepliesCheckResult.rows.length > 0) {
      // Table exists - drop it to ensure we have the correct FK constraint
      try {
        console.log('[' + new Date().toISOString() + '] Dropping existing SUPPORT_REPLIES table to rebuild with correct FK...');
        await connection.execute(`DROP TABLE SUPPORT_REPLIES CASCADE CONSTRAINTS`);
        console.log('[' + new Date().toISOString() + '] ✓ Dropped old SUPPORT_REPLIES table');
      } catch (dropErr) {
        console.log('[' + new Date().toISOString() + '] Could not drop table (may not exist), continue:', dropErr.message);
      }
    }
    
    // Now create the table with correct constraints
    console.log('[' + new Date().toISOString() + '] Creating SUPPORT_REPLIES table...');
    const createSupportRepliesQuery = `
      CREATE TABLE SUPPORT_REPLIES (
        REPLY_ID NUMBER PRIMARY KEY,
        QUESTION_ID NUMBER NOT NULL REFERENCES ZAIN_SUPPORT_ASKED_QUESTIONS(QUESTION_ID) ON DELETE CASCADE,
        REPLY_TEXT CLOB NOT NULL,
        REPLIED_BY VARCHAR2(50) NOT NULL,
        REPLIED_AT TIMESTAMP DEFAULT SYSDATE
      )
    `;

    const createReplySeqQuery = `CREATE SEQUENCE SUPPORT_REPLIES_SEQ START WITH 1 INCREMENT BY 1`;
    
    try {
      await connection.execute(createReplySeqQuery);
      console.log('[' + new Date().toISOString() + '] ✓ Created SUPPORT_REPLIES_SEQ sequence');
    } catch (err) {
      console.log('[' + new Date().toISOString() + '] Sequence may already exist:', err.message);
    }

    try {
      await connection.execute(createSupportRepliesQuery);
      console.log('[' + new Date().toISOString() + '] ✓ SUPPORT_REPLIES table created successfully with correct FK constraint');
    } catch (err) {
      console.error('[' + new Date().toISOString() + '] Error creating SUPPORT_REPLIES:', err.message);
    }

    await connection.close();
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error in database initialization:', err.message);
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
  }
}

async function createInitialUsers(connection) {
  try {
    // Check if users already exist
    const checkUsersQuery = `SELECT COUNT(*) as count FROM ZAINSUPPORTUSERS`;
    const result = await connection.execute(checkUsersQuery);
    
    if (result.rows[0][0] > 0) {
      console.log('[' + new Date().toISOString() + '] Users already exist in ZAINSUPPORTUSERS table');
      return;
    }

    // Hash passwords
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    const staffPasswordHash = await bcrypt.hash('staff123', 10);

    // Insert initial users
    const insertAdminQuery = `
      INSERT INTO ZAINSUPPORTUSERS (USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE)
      VALUES (ZAINSUPPORTUSERS_SEQ.NEXTVAL, 'admin', :adminPassword, 'admin', 1)
    `;

    const insertStaffQuery = `
      INSERT INTO ZAINSUPPORTUSERS (USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE)
      VALUES (ZAINSUPPORTUSERS_SEQ.NEXTVAL, 'staff', :staffPassword, 'staff', 1)
    `;

    await connection.execute(insertAdminQuery, { adminPassword: adminPasswordHash }, { autoCommit: true });
    console.log('[' + new Date().toISOString() + '] ✓ Admin user created (password: admin123)');

    await connection.execute(insertStaffQuery, { staffPassword: staffPasswordHash }, { autoCommit: true });
    console.log('[' + new Date().toISOString() + '] ✓ Staff user created (password: staff123)');

  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error creating initial users:', err.message);
  }
}

async function ensureDefaultUsers() {
  let connection;
  try {
    // Wait a bit for pool to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    connection = await connectionPool.getConnection();
    
    // Check if admin user exists
    const checkAdminQuery = `SELECT COUNT(*) as count FROM ZAINSUPPORTUSERS WHERE USERNAME = 'admin'`;
    const adminResult = await connection.execute(checkAdminQuery);
    
    if (adminResult.rows[0][0] === 0) {
      // Get next user ID
      const getMaxIdQuery = `SELECT NVL(MAX(USER_ID), 0) as maxId FROM ZAINSUPPORTUSERS`;
      const maxIdResult = await connection.execute(getMaxIdQuery);
      const nextUserId = (maxIdResult.rows[0][0] || 0) + 1;
      
      // Create admin user
      const adminPasswordHash = await bcrypt.hash('admin123', 10);
      const insertAdminQuery = `
        INSERT INTO ZAINSUPPORTUSERS (USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE)
        VALUES (:userId, 'admin', :adminPassword, 'admin', 1)
      `;
      await connection.execute(insertAdminQuery, { 
        userId: nextUserId,
        adminPassword: adminPasswordHash 
      }, { autoCommit: true });
      console.log('[' + new Date().toISOString() + '] ✓ Admin user created (username: admin, password: admin123)');
    } else {
      console.log('[' + new Date().toISOString() + '] Admin user already exists');
    }
    
    // Check if staff user exists
    const checkStaffQuery = `SELECT COUNT(*) as count FROM ZAINSUPPORTUSERS WHERE USERNAME = 'staff'`;
    const staffResult = await connection.execute(checkStaffQuery);
    
    if (staffResult.rows[0][0] === 0) {
      // Get next user ID
      const getMaxIdQuery = `SELECT NVL(MAX(USER_ID), 0) as maxId FROM ZAINSUPPORTUSERS`;
      const maxIdResult = await connection.execute(getMaxIdQuery);
      const nextUserId = (maxIdResult.rows[0][0] || 0) + 1;
      
      // Create staff user
      const staffPasswordHash = await bcrypt.hash('staff123', 10);
      const insertStaffQuery = `
        INSERT INTO ZAINSUPPORTUSERS (USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE)
        VALUES (:userId, 'staff', :staffPassword, 'staff', 1)
      `;
      await connection.execute(insertStaffQuery, { 
        userId: nextUserId,
        staffPassword: staffPasswordHash 
      }, { autoCommit: true });
      console.log('[' + new Date().toISOString() + '] ✓ Staff user created (username: staff, password: staff123)');
    } else {
      console.log('[' + new Date().toISOString() + '] Staff user already exists');
    }
    
    await connection.close();
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error ensuring default users:', err.message);
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
  }
}

async function logNumberUpdate(connection, mobileNumber, statusBefore, statusAfter, username) {
  try {
    const logQuery = `
      INSERT INTO ZAINSUPPORTNUMLOGS (LOG_ID, MOBILE_NUMBER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME)
      VALUES (ZAINSUPPORTNUMLOGS_SEQ.NEXTVAL, :mobileNumber, :statusBefore, :statusAfter, :username, SYSDATE)
    `;
    
    await connection.execute(logQuery, {
      mobileNumber: mobileNumber,
      statusBefore: statusBefore,
      statusAfter: statusAfter,
      username: username
    }, { autoCommit: true });
    
    console.log(`[${new Date().toISOString()}] Logged number update: ${mobileNumber} (${statusBefore} → ${statusAfter}) by ${username}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error logging number update:`, err.message);
  }
}

async function logSimUpdate(connection, simId, statusBefore, statusAfter, username) {
  try {
    const logQuery = `
      INSERT INTO ZAIN_SUPPORT_SIMS_LOGS (LOG_ID, SIM_IDENTIFIER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME)
      VALUES (ZAIN_SUPPORT_SIMS_LOGS_SEQ.NEXTVAL, :simId, :statusBefore, :statusAfter, :username, SYSDATE)
    `;
    
    await connection.execute(logQuery, {
      simId: simId,
      statusBefore: statusBefore,
      statusAfter: statusAfter,
      username: username
    }, { autoCommit: true });
    
    console.log(`[${new Date().toISOString()}] Logged SIM update: ${simId} (${statusBefore} → ${statusAfter}) by ${username}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error logging SIM update:`, err.message);
  }
}



async function initializePool() {
  try {
    console.log(`[${new Date().toISOString()}] Attempting to connect to Oracle DB: ${dbConfig.connectString}`);
    
    connectionPool = await oracledb.createPool({
      user: dbConfig.user,
      password: dbConfig.password,
      connectString: dbConfig.connectString,
      poolMax: 10,
      poolMin: 2,
      poolIncrement: 1,
      connectionClass: 'POOLED',
      waitTimeout: 60000,
      enableStatistics: false,
      _enableOracleClientV12: true,
      accessToken: undefined,
      externalAuth: false,
      connectTimeout: 120
    });
    poolRetries = 0;
    console.log('[' + new Date().toISOString() + '] Oracle Connection Pool Created Successfully');
    
    // Create users table after pool is initialized
    await createUsersTable();
    
    // Ensure default users exist
    await ensureDefaultUsers();
    
    // Create logging tables
    await createLoggingTables();

    // Load restricted numbers and statuses from database
    await refreshRestrictedNumbers();
    await refreshRestrictedStatuses();
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error creating connection pool:', err.message);
    
    // Retry logic
    if (poolRetries < MAX_RETRIES) {
      poolRetries++;
      console.log(`[${new Date().toISOString()}] Retrying connection (${poolRetries}/${MAX_RETRIES}) in 5 seconds...`);
      setTimeout(initializePool, 5000);
    } else {
      console.error(`[${new Date().toISOString()}] Max retries (${MAX_RETRIES}) exceeded. Exiting.`);
      console.error(`[${new Date().toISOString()}] Please verify:
        1. Database host is reachable: ${dbConfig.connectString}
        2. Database service is running
        3. Firewall allows port 1512
        4. Credentials are correct (User: ${dbConfig.user})`);
      process.exit(1);
    }
  }
}

// Refresh restricted numbers from database
async function refreshRestrictedNumbers() {
  try {
    const connection = await connectionPool.getConnection();
    const query = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX ORDER BY PREFIX`;
    const result = await connection.execute(query);
    restrictedNumbersCache = result.rows.map(row => row[0]);
    await connection.close();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error refreshing restricted numbers:`, err.message);
  }
}

async function refreshRestrictedStatuses() {
  try {
    const connection = await connectionPool.getConnection();
    const query = `SELECT STATUS_V FROM RESTRICTED_STATUSES ORDER BY STATUS_V`;
    const result = await connection.execute(query);
    restrictedStatusesCache = result.rows.map(row => row[0]);
    await connection.close();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error refreshing restricted statuses:`, err.message);
  }
}

async function refreshRestrictedCategories() {
  try {
    const connection = await connectionPool.getConnection();
    const query = `SELECT CATEGORY_CODE_V FROM RESTRICTED_NUMBERS_CATEGORY ORDER BY CATEGORY_CODE_V`;
    const result = await connection.execute(query);
    restrictedCategoriesCache = result.rows.map(row => row[0]);
    await connection.close();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error refreshing restricted categories:`, err.message);
  }
}

// API Route to get all restricted numbers (admin only)
app.get('/api/restricted-numbers', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can view restricted numbers'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    // Check if table exists
    const checkTableQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_NUMBERS_PREFIX'`;
    const tableCheckResult = await connection.execute(checkTableQuery);
    
    // If table doesn't exist, return empty array
    if (tableCheckResult.rows.length === 0) {
      return res.json({
        success: true,
        numbers: []
      });
    }
    
    const query = `SELECT PREFIX_ID, PREFIX, DESCRIPTION, CREATED_BY, CREATED_AT FROM RESTRICTED_NUMBERS_PREFIX ORDER BY CREATED_AT DESC`;
    const result = await connection.execute(query);

    const numbers = result.rows.map(row => ({
      prefixId: row[0],
      prefix: row[1],
      description: row[2],
      createdBy: row[3],
      createdAt: row[4]
    }));

    res.json({
      success: true,
      numbers: numbers
    });
  } catch (err) {
    console.error('Database error in /api/restricted-numbers:', err);
    // Return empty array gracefully instead of error
    res.json({
      success: true,
      numbers: [],
      warning: 'Could not load numbers, returning empty list'
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to add a restricted number (admin only)
app.post('/api/add-restricted-number', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can add restricted numbers'
    });
  }

  const { prefix, description } = req.body;

  if (!prefix) {
    return res.status(400).json({
      success: false,
      message: 'Prefix is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if prefix already exists
    const checkQuery = `SELECT COUNT(*) as count FROM RESTRICTED_NUMBERS_PREFIX WHERE PREFIX = :prefix`;
    const checkResult = await connection.execute(checkQuery, { prefix: prefix });
    
    if (checkResult.rows[0][0] > 0) {
      return res.status(400).json({
        success: false,
        message: 'This prefix is already in the restricted list'
      });
    }

    // Get next ID manually
    const maxIdQuery = `SELECT MAX(PREFIX_ID) FROM RESTRICTED_NUMBERS_PREFIX`;
    const maxIdResult = await connection.execute(maxIdQuery);
    const nextPrefixId = (maxIdResult.rows[0][0] || 0) + 1;

    // Insert new restricted number
    const insertQuery = `
      INSERT INTO RESTRICTED_NUMBERS_PREFIX (PREFIX_ID, PREFIX, DESCRIPTION, CREATED_BY)
      VALUES (:prefixId, :prefix, :description, :createdBy)
    `;

    await connection.execute(
      insertQuery,
      {
        prefixId: nextPrefixId,
        prefix: prefix,
        description: description || null,
        createdBy: req.session.user.username
      },
      { autoCommit: true }
    );

    // Refresh cache
    await refreshRestrictedNumbers();

    console.log(`[${new Date().toISOString()}] Restricted number prefix '${prefix}' added by ${req.session.user.username}`);

    res.json({
      success: true,
      message: `Prefix '${prefix}' added to restricted numbers successfully`
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to delete a restricted number (admin only)
app.post('/api/delete-restricted-number', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can delete restricted numbers'
    });
  }

  const { prefixId } = req.body;

  if (!prefixId) {
    return res.status(400).json({
      success: false,
      message: 'Prefix ID is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const deleteQuery = `DELETE FROM RESTRICTED_NUMBERS_PREFIX WHERE PREFIX_ID = :prefixId`;

    const result = await connection.execute(
      deleteQuery,
      { prefixId: prefixId },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      // Refresh cache
      await refreshRestrictedNumbers();

      console.log(`[${new Date().toISOString()}] Restricted number prefix ID ${prefixId} deleted by ${req.session.user.username}`);

      res.json({
        success: true,
        message: 'Restricted number removed successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Restricted number not found'
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get all recipient emails (admin only)
app.get('/api/recipient-emails', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can view recipient emails'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if table exists
    const checkTableQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RECIPIENT_EMAILS'`;
    const tableCheckResult = await connection.execute(checkTableQuery);
    
    // If table doesn't exist, return empty array
    if (tableCheckResult.rows.length === 0) {
      return res.json({
        success: true,
        emails: []
      });
    }

    const query = `SELECT EMAIL_ID, EMAIL, DESCRIPTION, ADDED_BY, ADDED_AT FROM RECIPIENT_EMAILS ORDER BY ADDED_AT DESC`;
    const result = await connection.execute(query);

    const emails = result.rows.map(row => ({
      emailId: row[0],
      email: row[1],
      description: row[2],
      addedBy: row[3],
      addedAt: row[4]
    }));

    res.json({
      success: true,
      emails: emails
    });

  } catch (err) {
    console.error('Database error in /api/recipient-emails:', err);
    // Return empty array gracefully instead of error
    res.json({
      success: true,
      emails: [],
      warning: 'Could not load emails, returning empty list'
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to add recipient email (admin and staff)
app.post('/api/add-recipient-email', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can add recipient emails'
    });
  }

  const { email, description } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: 'Email is required'
    });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid email format'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if email already exists
    const checkQuery = `SELECT COUNT(*) as count FROM RECIPIENT_EMAILS WHERE EMAIL = :email`;
    const checkResult = await connection.execute(checkQuery, { email: email });
    
    if (checkResult.rows[0][0] > 0) {
      return res.status(400).json({
        success: false,
        message: 'This email already exists in the recipient list'
      });
    }

    // Get next ID manually
    const maxIdQuery = `SELECT MAX(EMAIL_ID) FROM RECIPIENT_EMAILS`;
    const maxIdResult = await connection.execute(maxIdQuery);
    const nextEmailId = (maxIdResult.rows[0][0] || 0) + 1;

    const insertQuery = `
      INSERT INTO RECIPIENT_EMAILS (EMAIL_ID, EMAIL, DESCRIPTION, ADDED_BY)
      VALUES (:emailId, :email, :description, :addedBy)
    `;

    await connection.execute(
      insertQuery,
      { 
        emailId: nextEmailId,
        email: email, 
        description: description || null,
        addedBy: req.session.user.username
      },
      { autoCommit: true }
    );

    console.log(`[${new Date().toISOString()}] New recipient email ${email} added by ${req.session.user.username}`);

    res.json({
      success: true,
      message: `Email ${email} added successfully`
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to delete recipient email (admin and staff)
app.post('/api/delete-recipient-email', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can delete recipient emails'
    });
  }

  const { emailId } = req.body;

  if (!emailId) {
    return res.status(400).json({
      success: false,
      message: 'Email ID is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const deleteQuery = `DELETE FROM RECIPIENT_EMAILS WHERE EMAIL_ID = :emailId`;

    const result = await connection.execute(
      deleteQuery,
      { emailId: emailId },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      console.log(`[${new Date().toISOString()}] Recipient email ID ${emailId} deleted by ${req.session.user.username}`);

      res.json({
        success: true,
        message: 'Email recipient removed successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Email recipient not found'
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get email sending setting (admin only)
app.get('/api/email-setting', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can view email settings'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT SETTING_VALUE FROM APP_SETTINGS WHERE SETTING_KEY = 'EMAIL_SENDING_ENABLED'`;
    const result = await connection.execute(query);

    const emailEnabled = result.rows.length > 0 ? 
      result.rows[0][0].toLowerCase() === 'true' : 
      true;

    res.json({
      success: true,
      emailEnabled: emailEnabled
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get questions enabled setting (admin only)
app.get('/api/questions-setting', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can view questions settings'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT SETTING_VALUE FROM APP_SETTINGS WHERE SETTING_KEY = 'QUESTIONS_ENABLED'`;
    const result = await connection.execute(query);

    const questionsEnabled = result.rows.length > 0 ? 
      result.rows[0][0].toLowerCase() === 'true' : 
      true;

    res.json({
      success: true,
      questionsEnabled: questionsEnabled
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update questions enabled setting (admin only)
app.post('/api/update-questions-setting', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can update questions settings'
    });
  }

  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'enabled must be a boolean value'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // First check if the setting exists
    const checkQuery = `SELECT SETTING_ID FROM APP_SETTINGS WHERE SETTING_KEY = 'QUESTIONS_ENABLED'`;
    const checkResult = await connection.execute(checkQuery);

    let result;
    const value = enabled ? 'true' : 'false';
    const updatedBy = req.session.user.username;

    if (checkResult.rows.length > 0) {
      // Update existing setting
      const updateQuery = `
        UPDATE APP_SETTINGS 
        SET SETTING_VALUE = :value, UPDATED_BY = :updatedBy, UPDATED_AT = SYSDATE 
        WHERE SETTING_KEY = 'QUESTIONS_ENABLED'
      `;
      result = await connection.execute(
        updateQuery,
        { value, updatedBy },
        { autoCommit: true }
      );
      console.log(`[${new Date().toISOString()}] Support questions setting updated to ${enabled ? 'enabled' : 'disabled'} by ${updatedBy}`);
    } else {
      // Insert new setting if it doesn't exist
      const seqQuery = `SELECT APP_SETTINGS_SEQ.NEXTVAL as nextId FROM DUAL`;
      const seqResult = await connection.execute(seqQuery);
      const settingId = seqResult.rows[0][0];

      const insertQuery = `
        INSERT INTO APP_SETTINGS (SETTING_ID, SETTING_KEY, SETTING_VALUE, SETTING_TYPE, DESCRIPTION, UPDATED_BY, UPDATED_AT)
        VALUES (:settingId, 'QUESTIONS_ENABLED', :value, 'boolean', 'Enable or disable support questions', :updatedBy, SYSDATE)
      `;
      result = await connection.execute(
        insertQuery,
        { settingId, value, updatedBy },
        { autoCommit: true }
      );
      console.log(`[${new Date().toISOString()}] Support questions setting created with value ${enabled ? 'enabled' : 'disabled'} by ${updatedBy}`);
    }

    res.json({
      success: true,
      message: `Support questions ${enabled ? 'enabled' : 'disabled'} successfully`,
      questionsEnabled: enabled
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update email sending setting (admin only)
app.post('/api/update-email-setting', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can update email settings'
    });
  }

  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'enabled must be a boolean value'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // First check if the setting exists
    const checkQuery = `SELECT SETTING_ID FROM APP_SETTINGS WHERE SETTING_KEY = 'EMAIL_SENDING_ENABLED'`;
    const checkResult = await connection.execute(checkQuery);

    let result;
    const value = enabled ? 'true' : 'false';
    const updatedBy = req.session.user.username;

    if (checkResult.rows.length > 0) {
      // Update existing setting
      const updateQuery = `
        UPDATE APP_SETTINGS 
        SET SETTING_VALUE = :value, UPDATED_BY = :updatedBy, UPDATED_AT = SYSDATE 
        WHERE SETTING_KEY = 'EMAIL_SENDING_ENABLED'
      `;
      result = await connection.execute(
        updateQuery,
        { value, updatedBy },
        { autoCommit: true }
      );
      console.log(`[${new Date().toISOString()}] Email sending setting updated to ${enabled ? 'enabled' : 'disabled'} by ${updatedBy}`);
    } else {
      // Insert new setting if it doesn't exist
      const seqQuery = `SELECT APP_SETTINGS_SEQ.NEXTVAL as nextId FROM DUAL`;
      const seqResult = await connection.execute(seqQuery);
      const settingId = seqResult.rows[0][0];

      const insertQuery = `
        INSERT INTO APP_SETTINGS (SETTING_ID, SETTING_KEY, SETTING_VALUE, SETTING_TYPE, DESCRIPTION, UPDATED_BY, UPDATED_AT)
        VALUES (:settingId, 'EMAIL_SENDING_ENABLED', :value, 'boolean', 'Enable or disable email notifications', :updatedBy, SYSDATE)
      `;
      result = await connection.execute(
        insertQuery,
        { settingId, value, updatedBy },
        { autoCommit: true }
      );
      console.log(`[${new Date().toISOString()}] Email sending setting created with value ${enabled ? 'enabled' : 'disabled'} by ${updatedBy}`);
    }

    res.json({
      success: true,
      message: `Email sending ${enabled ? 'enabled' : 'disabled'} successfully`,
      emailEnabled: enabled
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get all restricted statuses (admin only)
app.get('/api/restricted-statuses', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can view restricted statuses'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    // Check if table exists
    const checkTableQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_STATUSES'`;
    const tableCheckResult = await connection.execute(checkTableQuery);
    
    // If table doesn't exist, return empty array
    if (tableCheckResult.rows.length === 0) {
      return res.json({
        success: true,
        statuses: []
      });
    }
    
    const query = `SELECT STATUS_ID, STATUS_V, DESCRIPTION, CREATED_BY, CREATED_AT FROM RESTRICTED_STATUSES ORDER BY CREATED_AT DESC`;
    const result = await connection.execute(query);

    const statuses = result.rows.map(row => ({
      statusId: row[0],
      statusV: row[1],
      description: row[2],
      createdBy: row[3],
      createdAt: row[4]
    }));

    res.json({
      success: true,
      statuses: statuses
    });

  } catch (err) {
    console.error('Database error in /api/restricted-statuses:', err);
    // Return empty array gracefully instead of error
    res.json({
      success: true,
      statuses: [],
      warning: 'Could not load statuses, returning empty list'
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to add restricted status (admin only)
app.post('/api/add-restricted-status', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can add restricted statuses'
    });
  }

  const { statusV, description } = req.body;

  if (!statusV) {
    return res.status(400).json({
      success: false,
      message: 'Status is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if status already exists
    const checkQuery = `SELECT COUNT(*) as count FROM RESTRICTED_STATUSES WHERE STATUS_V = :statusV`;
    const checkResult = await connection.execute(checkQuery, { statusV: statusV });
    
    if (checkResult.rows[0][0] > 0) {
      return res.status(400).json({
        success: false,
        message: 'This status is already restricted'
      });
    }

    // Get next ID manually
    const maxIdQuery = `SELECT MAX(STATUS_ID) FROM RESTRICTED_STATUSES`;
    const maxIdResult = await connection.execute(maxIdQuery);
    const nextStatusId = (maxIdResult.rows[0][0] || 0) + 1;

    const insertQuery = `
      INSERT INTO RESTRICTED_STATUSES (STATUS_ID, STATUS_V, DESCRIPTION, CREATED_BY)
      VALUES (:statusId, :statusV, :description, :createdBy)
    `;

    await connection.execute(
      insertQuery,
      { 
        statusId: nextStatusId,
        statusV: statusV, 
        description: description || null,
        createdBy: req.session.user.username
      },
      { autoCommit: true }
    );

    // Refresh cache
    await refreshRestrictedStatuses();

    console.log(`[${new Date().toISOString()}] Restricted status ${statusV} added by ${req.session.user.username}`);

    res.json({
      success: true,
      message: `Status ${statusV} added to restricted list successfully`
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to delete restricted status (admin only)
app.post('/api/delete-restricted-status', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can delete restricted statuses'
    });
  }

  const { statusId } = req.body;

  if (!statusId) {
    return res.status(400).json({
      success: false,
      message: 'Status ID is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const deleteQuery = `DELETE FROM RESTRICTED_STATUSES WHERE STATUS_ID = :statusId`;

    const result = await connection.execute(
      deleteQuery,
      { statusId: statusId },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      // Refresh cache
      await refreshRestrictedStatuses();

      console.log(`[${new Date().toISOString()}] Restricted status ID ${statusId} deleted by ${req.session.user.username}`);

      res.json({
        success: true,
        message: 'Restricted status removed successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Restricted status not found'
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get all restricted categories (admin only)
app.get('/api/restricted-categories', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can view restricted categories'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    // Check if table exists
    const checkTableQuery = `SELECT table_name FROM user_tables WHERE table_name = 'RESTRICTED_NUMBERS_CATEGORY'`;
    const tableCheckResult = await connection.execute(checkTableQuery);
    
    // If table doesn't exist, return empty array
    if (tableCheckResult.rows.length === 0) {
      return res.json({
        success: true,
        categories: []
      });
    }
    
    const query = `SELECT CATEGORY_ID, CATEGORY_CODE_V, DESCRIPTION, CREATED_BY, CREATED_AT FROM RESTRICTED_NUMBERS_CATEGORY ORDER BY CREATED_AT DESC`;
    const result = await connection.execute(query);

    const categories = result.rows.map(row => ({
      categoryId: row[0],
      categoryCodeV: row[1],
      description: row[2],
      createdBy: row[3],
      createdAt: row[4]
    }));

    res.json({
      success: true,
      categories: categories
    });

  } catch (err) {
    console.error('Database error in /api/restricted-categories:', err);
    // Return empty array gracefully instead of error
    res.json({
      success: true,
      categories: [],
      warning: 'Could not load categories, returning empty list'
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to add restricted category (admin only)
app.post('/api/add-restricted-category', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can add restricted categories'
    });
  }

  const { categoryCodeV, description } = req.body;

  if (!categoryCodeV) {
    return res.status(400).json({
      success: false,
      message: 'Category code is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if category already exists
    const checkQuery = `SELECT COUNT(*) as count FROM RESTRICTED_NUMBERS_CATEGORY WHERE CATEGORY_CODE_V = :categoryCodeV`;
    const checkResult = await connection.execute(checkQuery, { categoryCodeV: categoryCodeV });
    
    if (checkResult.rows[0][0] > 0) {
      return res.status(400).json({
        success: false,
        message: 'This category is already restricted'
      });
    }

    // Get next ID manually
    const maxIdQuery = `SELECT MAX(CATEGORY_ID) FROM RESTRICTED_NUMBERS_CATEGORY`;
    const maxIdResult = await connection.execute(maxIdQuery);
    const nextCategoryId = (maxIdResult.rows[0][0] || 0) + 1;

    // Insert new restricted category
    const insertQuery = `
      INSERT INTO RESTRICTED_NUMBERS_CATEGORY (CATEGORY_ID, CATEGORY_CODE_V, DESCRIPTION, CREATED_BY)
      VALUES (:categoryId, :categoryCodeV, :description, :createdBy)
    `;

    await connection.execute(
      insertQuery,
      {
        categoryId: nextCategoryId,
        categoryCodeV: categoryCodeV,
        description: description || 'Restricted category',
        createdBy: req.session.user.username
      },
      { autoCommit: true }
    );

    // Refresh cache
    await refreshRestrictedCategories();

    console.log(`[${new Date().toISOString()}] Restricted category ${categoryCodeV} added by ${req.session.user.username}`);

    res.json({
      success: true,
      message: `Category ${categoryCodeV} added to restricted list successfully`
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to delete restricted category (admin only)
app.post('/api/delete-restricted-category', requireAuth, async (req, res) => {
  if (!['admin', 'staff'].includes(req.session.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only admins and staff can delete restricted categories'
    });
  }

  const { categoryId } = req.body;

  if (!categoryId) {
    return res.status(400).json({
      success: false,
      message: 'Category ID is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const deleteQuery = `DELETE FROM RESTRICTED_NUMBERS_CATEGORY WHERE CATEGORY_ID = :categoryId`;

    const result = await connection.execute(
      deleteQuery,
      { categoryId: categoryId },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      // Refresh cache
      await refreshRestrictedCategories();

      console.log(`[${new Date().toISOString()}] Restricted category ID ${categoryId} deleted by ${req.session.user.username}`);

      res.json({
        success: true,
        message: 'Restricted category removed successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Restricted category not found'
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route for user login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Validation
  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE FROM ZAINSUPPORTUSERS 
                   WHERE USERNAME = :username AND ACTIVE = 1`;

    const result = await connection.execute(query, { username: username });

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    const user = result.rows[0];
    const userId = user[0];
    const dbUsername = user[1];
    const hashedPassword = user[2];
    const role = user[3];

    // Compare passwords
    const passwordMatch = await bcrypt.compare(password, hashedPassword);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    // Create session
    req.session.user = {
      id: userId,
      username: dbUsername,
      role: role
    };

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        username: dbUsername,
        role: role
      }
    });

    console.log(`[${new Date().toISOString()}] User '${dbUsername}' logged in successfully`);

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route for user logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        success: false,
        message: 'Could not log out'
      });
    }
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
});

// API Route to get current user
app.get('/api/current-user', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: 'No user logged in'
    });
  }
  res.json({
    success: true,
    user: req.session.user
  });
});

// API Route to get user info (same as current-user)
app.get('/api/user-info', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: 'No user logged in'
    });
  }
  res.json({
    success: true,
    user: req.session.user
  });
});

// API Route to create new user (admin only)
app.post('/api/create-user', requireAuth, async (req, res) => {
  // Check if user is admin
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can create new users'
    });
  }

  const { username, password, role } = req.body;

  // Validation
  if (!username || !password || !role) {
    return res.status(400).json({
      success: false,
      message: 'Username, password, and role are required'
    });
  }

  if (!['admin', 'staff'].includes(role.toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: 'Role must be either "admin" or "staff"'
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 6 characters long'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Check if username already exists
    const checkQuery = `SELECT COUNT(*) as count FROM ZAINSUPPORTUSERS WHERE USERNAME = :username`;
    const checkResult = await connection.execute(checkQuery, { username: username.toLowerCase() });
    
    if (checkResult.rows[0][0] > 0) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const insertQuery = `
      INSERT INTO ZAINSUPPORTUSERS (USER_ID, USERNAME, PASSWORD, ROLE, ACTIVE)
      VALUES (ZAINSUPPORTUSERS_SEQ.NEXTVAL, :username, :password, :role, 1)
    `;

    await connection.execute(
      insertQuery,
      {
        username: username.toLowerCase(),
        password: hashedPassword,
        role: role.toLowerCase()
      },
      { autoCommit: true }
    );

    console.log(`[${new Date().toISOString()}] New user '${username}' created by ${req.session.user.username}`);

    // Log and send email notification
    const emailSubject = `New User Account Created - ${username}`;
    const emailHtml = `
      <h2>New User Account Created</h2>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>Username:</strong> ${username}</p>
      <p><strong>Role:</strong> ${role}</p>
      <p><strong>Created By:</strong> ${req.session.user.username}</p>
      <p><strong>Status:</strong> Active</p>
      <p><strong>Account Details:</strong></p>
      <ul>
        <li>Username: <code>${username}</code></li>
        <li>Role: <code>${role}</code></li>
        <li>Password: Securely set (hashed with bcrypt)</li>
      </ul>
      <p style="color: #666; font-size: 12px; margin-top: 20px;">
        This is an automated notification. The user can login with the provided credentials.
      </p>
    `;

    // Send email to recipients
    const emailNotificationSent = await sendEmailNotification(
      emailSubject,
      emailHtml
    );

    res.json({
      success: true,
      message: `User '${username}' created successfully with role '${role}'`
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get all users (admin only)
app.get('/api/users', requireAuth, async (req, res) => {
  // Check if user is admin
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can view users'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `
      SELECT USER_ID, USERNAME, ROLE, ACTIVE, CREATED_AT 
      FROM ZAINSUPPORTUSERS 
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(query);

    const users = result.rows.map(row => ({
      userId: row[0],
      username: row[1],
      role: row[2],
      active: row[3] === 1,
      createdAt: row[4]
    }));

    res.json({
      success: true,
      users: users
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to disable/enable user (admin only)
app.post('/api/toggle-user', requireAuth, async (req, res) => {
  // Check if user is admin
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can modify users'
    });
  }

  const { userId, active } = req.body;

  if (!userId || active === undefined) {
    return res.status(400).json({
      success: false,
      message: 'User ID and active status are required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const updateQuery = `UPDATE ZAINSUPPORTUSERS SET ACTIVE = :active WHERE USER_ID = :userId`;

    const result = await connection.execute(
      updateQuery,
      { active: active ? 1 : 0, userId: userId },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      console.log(`[${new Date().toISOString()}] User ID ${userId} ${active ? 'enabled' : 'disabled'} by ${req.session.user.username}`);
      res.json({
        success: true,
        message: `User ${active ? 'enabled' : 'disabled'} successfully`
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to change password
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: 'Current password and new password are required'
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 6 characters long'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Get current user's password hash
    const query = `SELECT PASSWORD FROM ZAINSUPPORTUSERS WHERE USER_ID = :userId`;
    const result = await connection.execute(query, { userId: req.session.user.id });

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const hashedPassword = result.rows[0][0];

    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, hashedPassword);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const newHashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    const updateQuery = `UPDATE ZAINSUPPORTUSERS SET PASSWORD = :password WHERE USER_ID = :userId`;
    
    await connection.execute(
      updateQuery,
      { password: newHashedPassword, userId: req.session.user.id },
      { autoCommit: true }
    );

    console.log(`[${new Date().toISOString()}] Password changed for user ${req.session.user.username}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// Diagnostic endpoint to check connection status
app.get('/api/health', requireAuth, async (req, res) => {
  try {
    if (!connectionPool) {
      return res.status(503).json({
        status: 'disconnected',
        message: 'Connection pool not initialized'
      });
    }

    console.log(`[${new Date().toISOString()}] Health check: Attempting to get connection...`);
    const connection = await connectionPool.getConnection();
    console.log(`[${new Date().toISOString()}] Health check: Connection obtained, running test query...`);
    
    // Try a simple query
    const result = await connection.execute('SELECT 1 FROM DUAL');
    await connection.close();
    
    res.json({
      status: 'connected',
      database: dbConfig.connectString,
      user: dbConfig.user,
      message: 'Database connection successful',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Health check failed:`, err.message);
    res.status(503).json({
      status: 'error',
      message: 'Database connection failed: ' + err.message,
      database: dbConfig.connectString,
      user: dbConfig.user,
      errorCode: err.code,
      suggestions: [
        '1. Verify the database host is reachable: ping 172.168.101.103',
        '2. Check if port 1512 is open: telnet 172.168.101.103 1512',
        '3. Confirm Oracle database service is running',
        '4. Verify firewall allows outbound connection to port 1512',
        '5. Test credentials with SQL*Plus or another tool first',
        '6. Ensure service name ZSSUAT is correct',
        '7. Check if you need to use original database: 172.168.101.238:1521'
      ],
      timestamp: new Date().toISOString()
    });
  }
});

// Fallback test endpoint - try original database
app.get('/api/test-original-db', async (req, res) => {
  const originalDb = '172.168.101.238:1521/PDB1';
  const originalUser = 'CBS_DB_OPSUPP';
  const originalPass = 'CBS_DB_OPSUPP';
  
  try {
    console.log(`[${new Date().toISOString()}] Testing original database: ${originalDb}`);
    
    const testPool = await oracledb.createPool({
      user: originalUser,
      password: originalPass,
      connectString: originalDb,
      poolMax: 2,
      poolMin: 1,
      connectTimeout: 10
    });
    
    const conn = await testPool.getConnection();
    const result = await conn.execute('SELECT 1 FROM DUAL');
    await conn.close();
    await testPool.close();
    
    res.json({
      status: 'connected',
      message: 'Original database is reachable',
      database: originalDb,
      user: originalUser,
      action: 'Use these credentials instead if current settings fail'
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      message: 'Original database also unreachable: ' + err.message,
      database: originalDb,
      error: err.code
    });
  }
});

// Test email configuration endpoint
app.get('/api/test-email', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Testing email configuration...`);
    await transporter.verify();
    
    res.json({
      status: 'success',
      message: 'Email configuration is valid',
      emailConfig: {
        service: emailConfig.service,
        user: emailConfig.auth.user,
        from: 'devgmf98@gmail.com'
      }
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Email test failed:`, err.message);
    res.status(503).json({
      status: 'error',
      message: 'Email configuration error: ' + err.message,
      suggestions: [
        '1. Verify EMAIL_USER and EMAIL_PASSWORD in .env file',
        '2. Password should be exactly: xwtw hopa upef zmre (with spaces)',
        '3. Email should be: gabrielgmf98@gmail.com',
        '4. Check firewall allows outbound SMTP',
        '5. Restart the server after updating .env'
      ],
      emailConfig: {
        service: emailConfig.service,
        user: emailConfig.auth.user
      }
    });
  }
});

// Test Failed Logs Tables
app.get('/api/test-failed-logs', async (req, res) => {
  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    const results = {
      status: 'success',
      tables: {},
      sequences: {},
      testInsert: {}
    };

    // Check if failed numbers table exists
    try {
      const checkNumTable = `SELECT COUNT(*) as cnt FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_NUM_LOGS'`;
      const numTableResult = await connection.execute(checkNumTable);
      results.tables.failed_num_logs = numTableResult.rows[0][0] > 0 ? 'EXISTS' : 'NOT FOUND';
    } catch (e) {
      results.tables.failed_num_logs = 'ERROR: ' + e.message;
    }

    // Check if failed SIM table exists
    try {
      const checkSimTable = `SELECT COUNT(*) as cnt FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_SIM_LOGS'`;
      const simTableResult = await connection.execute(checkSimTable);
      results.tables.failed_sim_logs = simTableResult.rows[0][0] > 0 ? 'EXISTS' : 'NOT FOUND';
    } catch (e) {
      results.tables.failed_sim_logs = 'ERROR: ' + e.message;
    }

    // Check if sequences exist
    try {
      const checkNumSeq = `SELECT COUNT(*) as cnt FROM user_sequences WHERE sequence_name = 'ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ'`;
      const numSeqResult = await connection.execute(checkNumSeq);
      results.sequences.failed_num_logs_seq = numSeqResult.rows[0][0] > 0 ? 'EXISTS' : 'NOT FOUND';
    } catch (e) {
      results.sequences.failed_num_logs_seq = 'ERROR: ' + e.message;
    }

    try {
      const checkSimSeq = `SELECT COUNT(*) as cnt FROM user_sequences WHERE sequence_name = 'ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ'`;
      const simSeqResult = await connection.execute(checkSimSeq);
      results.sequences.failed_sim_logs_seq = simSeqResult.rows[0][0] > 0 ? 'EXISTS' : 'NOT FOUND';
    } catch (e) {
      results.sequences.failed_sim_logs_seq = 'ERROR: ' + e.message;
    }

    // Test insert into failed numbers table
    try {
      const testInsertNum = `
        INSERT INTO ZAIN_SUPPORT_FAILED_NUM_LOGS 
        (LOG_ID, MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT)
        VALUES (ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ.NEXTVAL, '923001234567', 'TEST - ping', 'test_user', SYSDATE)
      `;
      await connection.execute(testInsertNum, {}, { autoCommit: true });
      results.testInsert.failed_num_logs = 'SUCCESS';
    } catch (e) {
      results.testInsert.failed_num_logs = 'FAILED: ' + e.message;
    }

    // Test insert into failed SIM table
    try {
      const testInsertSim = `
        INSERT INTO ZAIN_SUPPORT_FAILED_SIM_LOGS 
        (LOG_ID, SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT)
        VALUES (ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ.NEXTVAL, '1234567890123456', 'TEST - ping', 'test_user', SYSDATE)
      `;
      await connection.execute(testInsertSim, {}, { autoCommit: true });
      results.testInsert.failed_sim_logs = 'SUCCESS';
    } catch (e) {
      results.testInsert.failed_sim_logs = 'FAILED: ' + e.message;
    }

    // Count records in tables
    try {
      const countNum = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_NUM_LOGS`;
      const countNumResult = await connection.execute(countNum);
      results.recordCounts = results.recordCounts || {};
      results.recordCounts.failed_num_logs = countNumResult.rows[0][0];
    } catch (e) {
      results.recordCounts = results.recordCounts || {};
      results.recordCounts.failed_num_logs = 'ERROR: ' + e.message;
    }

    try {
      const countSim = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_SIM_LOGS`;
      const countSimResult = await connection.execute(countSim);
      results.recordCounts = results.recordCounts || {};
      results.recordCounts.failed_sim_logs = countSimResult.rows[0][0];
    } catch (e) {
      results.recordCounts = results.recordCounts || {};
      results.recordCounts.failed_sim_logs = 'ERROR: ' + e.message;
    }

    res.json(results);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Test failed logs error:`, err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error testing failed logs: ' + err.message,
      error: err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

// API Route to diagnose failed logs - check if tables exist and have data
app.get('/api/diagnose-failed-logs', requireAuth, async (req, res) => {
  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    const diagnosis = {
      status: 'diagnostic',
      timestamp: new Date().toISOString(),
      tables: {},
      records: {}
    };

    // Check if failed numbers table exists
    try {
      const checkTableQuery = `SELECT COUNT(*) as cnt FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_NUM_LOGS'`;
      const tableCheckResult = await connection.execute(checkTableQuery);
      const tableExists = tableCheckResult.rows[0][0] > 0;
      diagnosis.tables.ZAIN_SUPPORT_FAILED_NUM_LOGS = tableExists ? 'EXISTS' : 'DOES NOT EXIST';
      
      if (tableExists) {
        // Try to count records
        const countQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_NUM_LOGS`;
        const countResult = await connection.execute(countQuery);
        diagnosis.records.ZAIN_SUPPORT_FAILED_NUM_LOGS = countResult.rows[0][0];
        
        // Get sample records
        const sampleQuery = `SELECT * FROM ZAIN_SUPPORT_FAILED_NUM_LOGS WHERE ROWNUM <= 5 ORDER BY CREATED_AT DESC`;
        const sampleResult = await connection.execute(sampleQuery);
        diagnosis.sample_records_num = sampleResult.rows.length;
        if (sampleResult.rows.length > 0) {
          diagnosis.first_record_num = {
            log_id: sampleResult.rows[0][0],
            mobile_number: sampleResult.rows[0][1],
            failure_reason: sampleResult.rows[0][2],
            username: sampleResult.rows[0][3],
            created_at: sampleResult.rows[0][4]
          };
        }
      }
    } catch (e) {
      diagnosis.tables.ZAIN_SUPPORT_FAILED_NUM_LOGS_error = e.message;
    }

    // Check if failed SIMs table exists
    try {
      const checkTableQuery = `SELECT COUNT(*) as cnt FROM user_tables WHERE table_name = 'ZAIN_SUPPORT_FAILED_SIM_LOGS'`;
      const tableCheckResult = await connection.execute(checkTableQuery);
      const tableExists = tableCheckResult.rows[0][0] > 0;
      diagnosis.tables.ZAIN_SUPPORT_FAILED_SIM_LOGS = tableExists ? 'EXISTS' : 'DOES NOT EXIST';
      
      if (tableExists) {
        // Try to count records
        const countQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_SIM_LOGS`;
        const countResult = await connection.execute(countQuery);
        diagnosis.records.ZAIN_SUPPORT_FAILED_SIM_LOGS = countResult.rows[0][0];
        
        // Get sample records
        const sampleQuery = `SELECT * FROM ZAIN_SUPPORT_FAILED_SIM_LOGS WHERE ROWNUM <= 5 ORDER BY CREATED_AT DESC`;
        const sampleResult = await connection.execute(sampleQuery);
        diagnosis.sample_records_sim = sampleResult.rows.length;
        if (sampleResult.rows.length > 0) {
          diagnosis.first_record_sim = {
            log_id: sampleResult.rows[0][0],
            sim_identifier: sampleResult.rows[0][1],
            failure_reason: sampleResult.rows[0][2],
            username: sampleResult.rows[0][3],
            created_at: sampleResult.rows[0][4]
          };
        }
      }
    } catch (e) {
      diagnosis.tables.ZAIN_SUPPORT_FAILED_SIM_LOGS_error = e.message;
    }

    // Check sequences
    try {
      const checkSeqQuery = `SELECT COUNT(*) as cnt FROM user_sequences WHERE sequence_name = 'ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ'`;
      const seqCheckResult = await connection.execute(checkSeqQuery);
      diagnosis.sequences = diagnosis.sequences || {};
      diagnosis.sequences.ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ = seqCheckResult.rows[0][0] > 0 ? 'EXISTS' : 'DOES NOT EXIST';
    } catch (e) {
      diagnosis.sequences_error = e.message;
    }

    try {
      const checkSeqQuery = `SELECT COUNT(*) as cnt FROM user_sequences WHERE sequence_name = 'ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ'`;
      const seqCheckResult = await connection.execute(checkSeqQuery);
      diagnosis.sequences = diagnosis.sequences || {};
      diagnosis.sequences.ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ = seqCheckResult.rows[0][0] > 0 ? 'EXISTS' : 'DOES NOT EXIST';
    } catch (e) {
      diagnosis.sequences_error = e.message;
    }

    console.log('[' + new Date().toISOString() + '] DIAGNOSTIC REPORT:', JSON.stringify(diagnosis, null, 2));
    res.json(diagnosis);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Diagnostic error:`, err.message);
    res.status(500).json({
      status: 'error',
      message: 'Diagnostic failed: ' + err.message,
      error: err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

// API Route to view failed logs
app.get('/api/view-failed-logs', requireAuth, async (req, res) => {
  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    const results = {
      status: 'success',
      failedNumbers: [],
      failedSims: [],
      summary: {
        totalFailedNumbers: 0,
        totalFailedSims: 0
      }
    };

    // Get failed numbers
    try {
      const numbersQuery = `
        SELECT LOG_ID, MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT
        FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
        ORDER BY CREATED_AT DESC
        FETCH FIRST 100 ROWS ONLY
      `;
      const numbersResult = await connection.execute(numbersQuery);
      
      if (numbersResult.rows && numbersResult.rows.length > 0) {
        results.failedNumbers = numbersResult.rows.map(row => ({
          log_id: row[0],
          mobile_number: row[1],
          failure_reason: row[2],
          username: row[3],
          created_at: row[4]
        }));
      }

      // Get count of failed numbers
      const countNumQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_NUM_LOGS`;
      const countNumResult = await connection.execute(countNumQuery);
      results.summary.totalFailedNumbers = countNumResult.rows[0][0];
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error retrieving failed numbers:`, e.message);
      results.failedNumbers = [];
      results.failedNumbersError = e.message;
    }

    // Get failed SIMs
    try {
      const simsQuery = `
        SELECT LOG_ID, SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT
        FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
        ORDER BY CREATED_AT DESC
        FETCH FIRST 100 ROWS ONLY
      `;
      const simsResult = await connection.execute(simsQuery);
      
      if (simsResult.rows && simsResult.rows.length > 0) {
        results.failedSims = simsResult.rows.map(row => ({
          log_id: row[0],
          sim_identifier: row[1],
          failure_reason: row[2],
          username: row[3],
          created_at: row[4]
        }));
      }

      // Get count of failed SIMs
      const countSimQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_SIM_LOGS`;
      const countSimResult = await connection.execute(countSimQuery);
      results.summary.totalFailedSims = countSimResult.rows[0][0];
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error retrieving failed SIMs:`, e.message);
      results.failedSims = [];
      results.failedSimsError = e.message;
    }

    res.json(results);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] View failed logs error:`, err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error retrieving failed logs: ' + err.message,
      error: err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

// API Route to update STATUS_V
app.post('/api/update-status', requireAuth, async (req, res) => {
  const { mobileNumber, statusValue, categoryCodeV } = req.body;

  // Validation
  if (!mobileNumber || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mobile number and status value are required' 
    });
  }

  // If category update is requested, only admins can do it
  if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can update mobile number categories.'
      });
    }
  }

  let connection;
  try {
    // Get connection from pool
    console.log(`[${new Date().toISOString()}] Getting connection from pool for mobile: ${mobileNumber}`);
    connection = await connectionPool.getConnection();
    console.log(`[${new Date().toISOString()}] Connection obtained successfully`);

    // First, check the current status and category
    const selectQuery = `SELECT STATUS_V, CATEGORY_CODE_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                        WHERE MOBILE_NUMBER_V = :mobileNumber`;
    
    const currentResult = await connection.execute(
      selectQuery,
      { mobileNumber: mobileNumber }
    );

    if (currentResult.rows.length === 0) {
      // Log this failure
      const failReason = 'Mobile number not found in database';
      await logFailedNumber(connection, mobileNumber, failReason, req.session.user.username);
      
      return res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

    const currentStatus = currentResult.rows[0][0];
    const currentCategory = currentResult.rows[0][1];
    
    // Check if current status is restricted - if it is, NO ONE can update it
    const restrictedStatusCheckQuery = `SELECT COUNT(*) as count FROM RESTRICTED_STATUSES 
                                        WHERE STATUS_V = :statusV`;
    const restrictedStatusResult = await connection.execute(restrictedStatusCheckQuery, 
      { statusV: currentStatus.toString().toUpperCase() });
    
    if (restrictedStatusResult.rows[0][0] > 0) {
      // Log this failure
      const failReason = `Restricted current status: ${currentStatus}`;
      await logFailedNumber(connection, mobileNumber, failReason, req.session.user.username);
      
      return res.status(403).json({
        success: false,
        message: `Cannot update. Mobile number ${mobileNumber} has a restricted status (${currentStatus}). No updates allowed for this status.`
      });
    }

    // Check if current category is restricted - only admins can update numbers with restricted categories
    if (currentCategory && restrictedCategoriesCache.includes(currentCategory)) {
      if (req.session.user.role !== 'admin') {
        const failReason = `Restricted current category: ${currentCategory}`;
        await logFailedNumber(connection, mobileNumber, failReason, req.session.user.username);
        
        return res.status(403).json({
          success: false,
          message: `Cannot update. Mobile number ${mobileNumber} has a restricted category (${currentCategory}). Only admins can modify numbers with restricted categories.`
        });
      }
    }

    // Check if trying to set a new restricted category - only admins can do it
    if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
      if (restrictedCategoriesCache.includes(categoryCodeV.toUpperCase())) {
        if (req.session.user.role !== 'admin') {
          return res.status(403).json({
            success: false,
            message: `Cannot set restricted category. Only admins can assign restricted categories.`
          });
        }
      }
    }
    
    // Check if mobile number matches any restricted prefix - only admins can update
    const restrictedPrefixCheckQuery = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX`;
    const restrictedPrefixResult = await connection.execute(restrictedPrefixCheckQuery);
    const restrictedPrefixes = restrictedPrefixResult.rows.map(row => row[0]);
    
    const isRestrictedPrefix = restrictedPrefixes.some(prefix => matchesPrefix(mobileNumber, prefix));
    
    if (isRestrictedPrefix) {
      // Only admins can update restricted prefix numbers
      if (req.session.user.role !== 'admin') {
        // Log this failure
        const failReason = `Restricted prefix - admin access required`;
        await logFailedNumber(connection, mobileNumber, failReason, req.session.user.username);
        
        return res.status(403).json({
          success: false,
          message: `Access denied. Mobile number ${mobileNumber} matches a restricted prefix. Only admins can update restricted numbers.`
        });
      }
      console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is updating restricted mobile number ${mobileNumber}`);
    }

    // Build update query based on what fields need updating
    let updateQuery;
    let updateParams;
    
    if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
      updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                     SET STATUS_V = :statusValue, CATEGORY_CODE_V = :categoryCodeV
                     WHERE MOBILE_NUMBER_V = :mobileNumber`;
      updateParams = {
        statusValue: statusValue,
        categoryCodeV: categoryCodeV.toUpperCase(),
        mobileNumber: mobileNumber
      };
    } else {
      updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                     SET STATUS_V = :statusValue 
                     WHERE MOBILE_NUMBER_V = :mobileNumber`;
      updateParams = {
        statusValue: statusValue,
        mobileNumber: mobileNumber
      };
    }

    const result = await connection.execute(
      updateQuery,
      updateParams,
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      // Log the update
      await logNumberUpdate(connection, mobileNumber, currentStatus, statusValue, req.session.user.username);
      
      // Send email notification
      const emailSubject = `Mobile Status Update - ${mobileNumber}`;
      let updateDetails = `<tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>New Status</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong style="color: green;">${statusValue}</strong></td>
          </tr>`;
      
      if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
        updateDetails += `<tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>New Category</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong style="color: green;">${categoryCodeV.toUpperCase()}</strong></td>
          </tr>`;
      }

      const emailHtml = `
        <h2>Mobile Number Status Update Report</h2>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>Mobile Number:</strong> ${mobileNumber}</p>
        <p><strong>Updated By User:</strong> ${req.session.user.username}</p>
        <table style="border-collapse: collapse; margin: 20px 0; width: 100%;">
          <tr style="background: #f5f5f5;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Field</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Value</th>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Mobile Number</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;">${mobileNumber}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Previous Status</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;">${currentStatus}</td>
          </tr>
          ${updateDetails}
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Updated By</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;">${req.session.user.username}</td>
          </tr>
        </table>
      `;

      // Send email to recipients
      const emailNotificationSent = await sendEmailNotification(
        emailSubject,
        emailHtml
      );
      
      res.json({
        success: true,
        message: `Status updated successfully for mobile number: ${mobileNumber}`,
        rowsUpdated: result.rowsAffected
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update STATUS_V in GSM_SIMS_MASTER (supports comma or space separated entries)
app.post('/api/update-sims-status', requireAuth, async (req, res) => {
  const { simIdentifier, statusValue } = req.body;

  // Validation
  if (!simIdentifier || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'SIM identifier (comma or space separated) and status value are required' 
    });
  }

  let connection;
  try {
    // Parse input - support comma and space separated values
    const simList = simIdentifier
      .split(/[,\s]+/) // Split by comma or space
      .map(sim => sim.trim())
      .filter(sim => sim.length > 0);

    if (simList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid SIM identifiers provided'
      });
    }

    console.log(`[${new Date().toISOString()}] Updating GSM_SIMS_MASTER for ${simList.length} SIM(s): ${simList.join(', ')}`);
    
    connection = await connectionPool.getConnection();
    
    let successCount = 0;
    let restrictedCount = 0;
    let failureCount = 0;
    const failedSims = [];

    // Fetch restricted statuses and prefixes from database once for all SIMs
    const restrictedStatusesQuery = `SELECT STATUS_V FROM RESTRICTED_STATUSES`;
    const restrictedStatusesResult = await connection.execute(restrictedStatusesQuery);
    const restrictedStatuses = restrictedStatusesResult.rows.map(row => row[0].toString().toUpperCase());
    
    const restrictedPrefixesQuery = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX`;
    const restrictedPrefixesResult = await connection.execute(restrictedPrefixesQuery);
    const restrictedPrefixes = restrictedPrefixesResult.rows.map(row => row[0]);
    
    // Process each SIM identifier
    for (const sim of simList) {
      try {
        // First, check the current status
        const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_SIMS_MASTER 
                            WHERE SIM_IDENTIFIER_V = :simId`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { simId: sim }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          const failReason = 'SIM not found in database';
          failedSims.push(`${sim} (not found)`);
          await logFailedSim(connection, sim, failReason, req.session.user.username);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];

        // Check if current status is restricted - if it is, NO ONE can update it
        if (restrictedStatuses.includes(currentStatus.toString().toUpperCase())) {
          restrictedCount++;
          const failReason = `Restricted current status: ${currentStatus}`;
          failedSims.push(`${sim} (restricted status - no updates allowed)`);
          await logFailedSim(connection, sim, failReason, req.session.user.username);
          console.log(`[${new Date().toISOString()}] Cannot update SIM ${sim} - has restricted status ${currentStatus}`);
          continue;
        }

        // Check if SIM matches a restricted prefix - only admins can update
        const isSimRestrictedPrefix = restrictedPrefixes.some(prefix => matchesPrefix(sim, prefix));
        if (isSimRestrictedPrefix) {
          // Only admins can update restricted prefix SIMs
          if (req.session.user.role !== 'admin') {
            restrictedCount++;
            const failReason = `Restricted prefix - admin access required`;
            failedSims.push(`${sim} (restricted prefix - admin only)`);
            await logFailedSim(connection, sim, failReason, req.session.user.username);
            console.log(`[${new Date().toISOString()}] User ${req.session.user.username} attempted to update restricted SIM ${sim}`);
            continue;
          }
          console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is updating restricted SIM ${sim}`);
        }

        // Update query for GSM_SIMS_MASTER
        const updateQuery = `UPDATE CBS_CORE.GSM_SIMS_MASTER 
                            SET STATUS_V = :statusValue 
                            WHERE SIM_IDENTIFIER_V = :simId`;

        const result = await connection.execute(
          updateQuery,
          {
            statusValue: statusValue,
            simId: sim
          },
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
          // Log the update
          await logSimUpdate(connection, sim, currentStatus, statusValue, req.session.user.username);
          console.log(`[${new Date().toISOString()}] Updated SIM ${sim} status to ${statusValue}`);
        } else {
          failureCount++;
          const failReason = 'Update failed - no rows affected';
          failedSims.push(`${sim} (no rows affected)`);
          await logFailedSim(connection, sim, failReason, req.session.user.username);
        }
      } catch (err) {
        failureCount++;
        const failReason = err.message;
        failedSims.push(`${sim} (error: ${err.message})`);
        await logFailedSim(connection, sim, failReason, req.session.user.username);
        console.error(`[${new Date().toISOString()}] Error updating SIM ${sim}:`, err.message);
      }
    }

    let message = `Updated ${successCount} SIM(s) successfully`;
    if (restrictedCount > 0) message += ` | Skipped ${restrictedCount} SIM(s) with status A`;
    if (failureCount > 0) {
      message += ` | Failed: ${failureCount}`;
      message += ` | Issues: ${failedSims.join('; ')}`;
    }

    // Send email notification if any SIMs were updated
    if (successCount > 0) {
      const emailSubject = `SIM Status Update Notification - ${successCount} SIM(s) Updated`;
      const emailHtml = `
        <h2>SIM Status Update Report</h2>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>Total SIMs Processed:</strong> ${simList.length}</p>
        <p><strong>Successfully Updated:</strong> ${successCount}</p>
        <p><strong>Status Updated to:</strong> ${statusValue}</p>
        <p><strong>Updated By:</strong> ${req.session.user.username}</p>
        <p><strong>Restricted (Not Updated):</strong> ${restrictedCount}</p>
        <p><strong>Failed:</strong> ${failureCount}</p>
        ${failureCount > 0 ? `<p><strong>Failed SIMs:</strong> ${failedSims.join(', ')}</p>` : ''}
        <p><strong>Updated SIM Identifiers:</strong></p>
        <ul>
          ${simList.filter((sim, index) => {
            return !failedSims.some(failed => failed.startsWith(sim));
          }).map(sim => `<li>${sim}</li>`).join('')}
        </ul>
      `;
      
      // Send email to recipients
      const emailNotificationSent = await sendEmailNotification(emailSubject, emailHtml);
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: simList.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update STATUS_V in GSM_SIMS_MASTER by SIM_NUM_V (supports comma or space separated entries)
app.post('/api/update-sim-num-status', requireAuth, async (req, res) => {
  const { simNum, statusValue } = req.body;

  // Validation
  if (!simNum || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'SIM number (comma or space separated) and status value are required' 
    });
  }

  let connection;
  try {
    // Parse input - support comma and space separated values
    const simNumList = simNum
      .split(/[,\s]+/) // Split by comma or space
      .map(num => num.trim())
      .filter(num => num.length > 0);

    if (simNumList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid SIM numbers provided'
      });
    }

    console.log(`[${new Date().toISOString()}] Updating GSM_SIMS_MASTER by SIM_NUM_V for ${simNumList.length} SIM(s): ${simNumList.join(', ')}`);
    
    connection = await connectionPool.getConnection();
    
    let successCount = 0;
    let restrictedCount = 0;
    let failureCount = 0;
    const failedSims = [];

    // Fetch restricted statuses and prefixes from database once for all SIM numbers
    const restrictedStatusesQuery = `SELECT STATUS_V FROM RESTRICTED_STATUSES`;
    const restrictedStatusesResult = await connection.execute(restrictedStatusesQuery);
    const restrictedStatuses = restrictedStatusesResult.rows.map(row => row[0].toString().toUpperCase());
    
    const restrictedPrefixesQuery = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX`;
    const restrictedPrefixesResult = await connection.execute(restrictedPrefixesQuery);
    const restrictedPrefixes = restrictedPrefixesResult.rows.map(row => row[0]);
    
    // Process each SIM number
    for (const num of simNumList) {
      try {
        // First, check the current status
        const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_SIMS_MASTER 
                            WHERE SIM_NUM_V = :simNum`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { simNum: num }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          const failReason = 'SIM number not found in database';
          failedSims.push(`${num} (not found)`);
          await logFailedSim(connection, num, failReason, req.session.user.username);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];

        // Check if current status is restricted - if it is, NO ONE can update it
        if (restrictedStatuses.includes(currentStatus.toString().toUpperCase())) {
          restrictedCount++;
          const failReason = `Restricted current status: ${currentStatus}`;
          failedSims.push(`${num} (restricted status - no updates allowed)`);
          await logFailedSim(connection, num, failReason, req.session.user.username);
          console.log(`[${new Date().toISOString()}] Cannot update SIM number ${num} - has restricted status ${currentStatus}`);
          continue;
        }

        // Check if SIM number matches a restricted prefix - only admins can update
        const isNumRestrictedPrefix = restrictedPrefixes.some(prefix => matchesPrefix(num, prefix));
        if (isNumRestrictedPrefix) {
          // Only admins can update restricted prefix SIM numbers
          if (req.session.user.role !== 'admin') {
            restrictedCount++;
            const failReason = `Restricted prefix - admin access required`;
            failedSims.push(`${num} (restricted prefix - admin only)`);
            await logFailedSim(connection, num, failReason, req.session.user.username);
            console.log(`[${new Date().toISOString()}] User ${req.session.user.username} attempted to update restricted SIM number ${num}`);
            continue;
          }
          console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is updating restricted SIM number ${num}`);
        }

        // Update query for GSM_SIMS_MASTER by SIM_NUM_V
        const updateQuery = `UPDATE CBS_CORE.GSM_SIMS_MASTER 
                            SET STATUS_V = :statusValue 
                            WHERE SIM_NUM_V = :simNum`;

        const result = await connection.execute(
          updateQuery,
          {
            statusValue: statusValue,
            simNum: num
          },
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
          // Log the update
          await logSimUpdate(connection, num, currentStatus, statusValue, req.session.user.username);
          console.log(`[${new Date().toISOString()}] Updated SIM number ${num} status to ${statusValue}`);
        } else {
          failureCount++;
          const failReason = 'Update failed - no rows affected';
          failedSims.push(`${num} (no rows affected)`);
          await logFailedSim(connection, num, failReason, req.session.user.username);
        }
      } catch (err) {
        failureCount++;
        const failReason = err.message;
        failedSims.push(`${num} (error: ${err.message})`);
        await logFailedSim(connection, num, failReason, req.session.user.username);
        console.error(`[${new Date().toISOString()}] Error updating SIM number ${num}:`, err.message);
      }
    }

    let message = `Updated ${successCount} SIM number(s) successfully`;
    if (restrictedCount > 0) message += ` | Skipped ${restrictedCount} SIM(s) with status A`;
    if (failureCount > 0) {
      message += ` | Failed: ${failureCount}`;
      message += ` | Issues: ${failedSims.join('; ')}`;
    }

    // Send email notification if any SIMs were updated
    if (successCount > 0) {
      const emailSubject = `SIM Status Update Notification - ${successCount} SIM(s) Updated (by SIM Number)`;
      const emailHtml = `
        <h2>SIM Status Update Report</h2>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>Total SIMs Processed:</strong> ${simNumList.length}</p>
        <p><strong>Successfully Updated:</strong> ${successCount}</p>
        <p><strong>Status Updated to:</strong> ${statusValue}</p>
        <p><strong>Updated By:</strong> ${req.session.user.username}</p>
        <p><strong>Restricted (Not Updated):</strong> ${restrictedCount}</p>
        <p><strong>Failed:</strong> ${failureCount}</p>
        ${failureCount > 0 ? `<p><strong>Failed SIMs:</strong> ${failedSims.join(', ')}</p>` : ''}
        <p><strong>Updated SIM Numbers:</strong></p>
        <ul>
          ${simNumList.filter((num, index) => {
            return !failedSims.some(failed => failed.startsWith(num));
          }).map(num => `<li>${num}</li>`).join('')}
        </ul>
      `;
      
      // Send email to recipients
      const emailNotificationSent = await sendEmailNotification(emailSubject, emailHtml);
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: simNumList.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get mobile number details
app.get('/api/get-mobile-details/:mobileNumber', requireAuth, async (req, res) => {
  const { mobileNumber } = req.params;

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT MOBILE_NUMBER_V, CATEGORY_CODE_V, STATUS_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                   WHERE MOBILE_NUMBER_V = :mobileNumber`;

    const result = await connection.execute(query, { mobileNumber: mobileNumber });

    if (result.rows.length > 0) {
      res.json({
        success: true,
        data: {
          mobileNumber: result.rows[0][0],
          categoryCode: result.rows[0][1],
          status: result.rows[0][2]
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to free/clear a category (with restriction check)
app.post('/api/free-category', requireAuth, async (req, res) => {
  const { mobileNumber } = req.body;

  if (!mobileNumber) {
    return res.status(400).json({
      success: false,
      message: 'Mobile number is required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // First, get the current status and category of the mobile number
    const selectQuery = `SELECT STATUS_V, CATEGORY_CODE_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                         WHERE MOBILE_NUMBER_V = :mobileNumber`;
    const selectResult = await connection.execute(selectQuery, { mobileNumber: mobileNumber });

    if (selectResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

    const currentStatus = selectResult.rows[0][0];
    const currentCategory = selectResult.rows[0][1];

    // Check if current status is restricted - if so, only admins can free
    const isStatusRestricted = currentStatus && restrictedStatusesCache.includes(currentStatus.toUpperCase());
    const isCategoryRestricted = currentCategory && restrictedCategoriesCache.includes(currentCategory);

    // Check if mobile number matches any restricted prefix - only admins can free
    const restrictedPrefixCheckQuery = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX`;
    const restrictedPrefixResult = await connection.execute(restrictedPrefixCheckQuery);
    const restrictedPrefixes = restrictedPrefixResult.rows.map(row => row[0]);
    
    const isRestrictedPrefix = restrictedPrefixes.some(prefix => matchesPrefix(mobileNumber, prefix));

    // If any restriction exists, only admins can free
    if (isStatusRestricted || isCategoryRestricted || isRestrictedPrefix) {
      if (req.session.user.role !== 'admin') {
        if (isStatusRestricted) {
          return res.status(403).json({
            success: false,
            message: `Cannot free. Mobile number ${mobileNumber} has a restricted status. Only admins can modify.`
          });
        } else if (isCategoryRestricted) {
          return res.status(403).json({
            success: false,
            message: `Cannot free. Mobile number ${mobileNumber} has a restricted category. Only admins can modify.`
          });
        } else if (isRestrictedPrefix) {
          return res.status(403).json({
            success: false,
            message: `Cannot free. Mobile number ${mobileNumber} matches a restricted prefix. Only admins can modify.`
          });
        }
      }
      if (isCategoryRestricted) {
        console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is freeing restricted category ${currentCategory} for mobile ${mobileNumber}`);
      }
      if (isRestrictedPrefix) {
        console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is freeing restricted prefix number ${mobileNumber}`);
      }
    } else {
      // All are unrestricted - staff can also free
      console.log(`[${new Date().toISOString()}] User ${req.session.user.username} is freeing unrestricted status for mobile ${mobileNumber}`);
    }

    // Free the category by setting STATUS_V to 'F' (but keep the category code)
    const updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                        SET STATUS_V = 'F'
                        WHERE MOBILE_NUMBER_V = :mobileNumber`;

    const updateResult = await connection.execute(
      updateQuery,
      { mobileNumber: mobileNumber },
      { autoCommit: true }
    );

    if (updateResult.rowsAffected > 0) {
      // Log the status free operation
      const logQuery = `INSERT INTO UPDATE_LOGS (LOG_ID, MOBILE_NUMBER_V, PREVIOUS_VALUE, NEW_VALUE, FIELD_MODIFIED, MODIFIED_BY, MODIFIED_AT)
                        VALUES (UPDATE_LOGS_SEQ.NEXTVAL, :mobileNumber, :previousStatus, 'F', 'STATUS_V', :modifiedBy, SYSDATE)`;
      
      try {
        await connection.execute(
          logQuery,
          {
            mobileNumber: mobileNumber,
            previousStatus: currentStatus,
            modifiedBy: req.session.user.username
          },
          { autoCommit: true }
        );
      } catch (logErr) {
        console.warn(`[${new Date().toISOString()}] Warning: Could not log status free operation:`, logErr.message);
      }

      console.log(`[${new Date().toISOString()}] Status freed for mobile number ${mobileNumber} by ${req.session.user.username} (Previous status: ${currentStatus}, Category kept: ${currentCategory})`);

      res.json({
        success: true,
        message: `Status freed successfully for mobile number: ${mobileNumber}`,
        previousStatus: currentStatus,
        categoryPreserved: currentCategory,
        rowsUpdated: updateResult.rowsAffected
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get status (optional - for verification)
app.get('/api/get-status/:mobileNumber', requireAuth, async (req, res) => {
  const { mobileNumber } = req.params;

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT MOBILE_NUMBER_V, STATUS_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                   WHERE MOBILE_NUMBER_V = :mobileNumber`;

    const result = await connection.execute(query, { mobileNumber: mobileNumber });

    if (result.rows.length > 0) {
      res.json({
        success: true,
        data: {
          mobileNumber: result.rows[0][0],
          status: result.rows[0][1]
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route for bulk update
app.post('/api/bulk-update-status', requireAuth, async (req, res) => {
  const { mobileNumbers, statusValue, categoryCodeV } = req.body;

  // Validation
  if (!mobileNumbers || !Array.isArray(mobileNumbers) || mobileNumbers.length === 0 || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mobile numbers array and status value are required' 
    });
  }

  // If category update is requested, only admins can do it
  if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only administrators can update mobile number categories.'
      });
    }
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    let successCount = 0;
    let failureCount = 0;
    let restrictedCount = 0;
    const failedNumbers = [];

    // Fetch restricted statuses and prefixes from database once for all numbers
    const restrictedStatusesQuery = `SELECT STATUS_V FROM RESTRICTED_STATUSES`;
    const restrictedStatusesResult = await connection.execute(restrictedStatusesQuery);
    const restrictedStatuses = restrictedStatusesResult.rows.map(row => row[0].toString().toUpperCase());
    
    const restrictedPrefixesQuery = `SELECT PREFIX FROM RESTRICTED_NUMBERS_PREFIX`;
    const restrictedPrefixesResult = await connection.execute(restrictedPrefixesQuery);
    const restrictedPrefixes = restrictedPrefixesResult.rows.map(row => row[0]);

    // Process each mobile number
    for (const mobileNumber of mobileNumbers) {
      try {
        // First, check the current status and category
        const selectQuery = `SELECT STATUS_V, CATEGORY_CODE_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                            WHERE MOBILE_NUMBER_V = :mobileNumber`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { mobileNumber: mobileNumber.trim() }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          const failReason = 'Mobile number not found in database';
          failedNumbers.push(`${mobileNumber} - Not found`);
          await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];
        const currentCategory = currentResult.rows[0][1];

        // Check if current status is restricted - if it is, NO ONE can update it
        if (restrictedStatuses.includes(currentStatus.toString().toUpperCase())) {
          restrictedCount++;
          const failReason = `Restricted current status: ${currentStatus}`;
          failedNumbers.push(`${mobileNumber} - Restricted status (no updates allowed)`);
          await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
          console.log(`[${new Date().toISOString()}] Cannot update ${mobileNumber} - has restricted status ${currentStatus}`);
          continue;
        }

        // Check if current category is restricted - only admins can update numbers with restricted categories
        if (currentCategory && restrictedCategoriesCache.includes(currentCategory)) {
          if (req.session.user.role !== 'admin') {
            restrictedCount++;
            const failReason = `Restricted current category: ${currentCategory}`;
            failedNumbers.push(`${mobileNumber} - Restricted category (admin only)`);
            await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
            console.log(`[${new Date().toISOString()}] Cannot update ${mobileNumber} - has restricted category ${currentCategory}, only admins allowed`);
            continue;
          }
        }

        // Check if mobile number matches a restricted prefix - only admins can update
        const isMobileRestrictedPrefix = restrictedPrefixes.some(prefix => matchesPrefix(mobileNumber, prefix));
        if (isMobileRestrictedPrefix) {
          // Only admins can update restricted prefix numbers
          if (req.session.user.role !== 'admin') {
            restrictedCount++;
            const failReason = `Restricted prefix - admin access required`;
            failedNumbers.push(`${mobileNumber} - Restricted prefix (admin only)`);
            await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
            console.log(`[${new Date().toISOString()}] User ${req.session.user.username} attempted to update restricted mobile ${mobileNumber}`);
            continue;
          }
          console.log(`[${new Date().toISOString()}] Admin ${req.session.user.username} is updating restricted mobile ${mobileNumber}`);
        }

        // Update the status and optionally category
        let updateQuery;
        let updateParams;
        
        if (categoryCodeV !== undefined && categoryCodeV !== null && categoryCodeV !== '') {
          updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                         SET STATUS_V = :statusValue, CATEGORY_CODE_V = :categoryCodeV
                         WHERE MOBILE_NUMBER_V = :mobileNumber`;
          updateParams = {
            statusValue: statusValue,
            categoryCodeV: categoryCodeV.toUpperCase(),
            mobileNumber: mobileNumber.trim()
          };
        } else {
          updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                         SET STATUS_V = :statusValue 
                         WHERE MOBILE_NUMBER_V = :mobileNumber`;
          updateParams = {
            statusValue: statusValue,
            mobileNumber: mobileNumber.trim()
          };
        }

        const result = await connection.execute(
          updateQuery,
          updateParams,
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
          // Log the update
          await logNumberUpdate(connection, mobileNumber.trim(), currentStatus, statusValue, req.session.user.username);
        } else {
          failureCount++;
          const failReason = 'Update failed - no rows affected';
          failedNumbers.push(`${mobileNumber} - Update failed`);
          await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
        }
      } catch (err) {
        failureCount++;
        const failReason = err.message;
        failedNumbers.push(`${mobileNumber} - Error: ${err.message}`);
        await logFailedNumber(connection, mobileNumber.trim(), failReason, req.session.user.username);
      }
    }

    // Build response message
    let message = `Updated: ${successCount}, Restricted: ${restrictedCount}, Failed: ${failureCount}`;
    if (failedNumbers.length > 0 && failedNumbers.length <= 5) {
      message += ` | Issues: ${failedNumbers.join('; ')}`;
    }

    // Send email notification if any mobile numbers were updated
    if (successCount > 0) {
      const emailSubject = `SIM Status Update Notification - ${successCount} Mobile(s) Updated`;
      const updatedMobiles = mobileNumbers.filter(num => 
        !failedNumbers.some(failed => failed.startsWith(num.trim()))
      );
      const emailHtml = `
        <h2>SIM Status Update Report</h2>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <p><strong>Total Mobiles Processed:</strong> ${mobileNumbers.length}</p>
        <p><strong>Successfully Updated:</strong> ${successCount}</p>
        <p><strong>Status Updated to:</strong> ${statusValue}</p>
        <p><strong>Updated By:</strong> ${req.session.user.username}</p>
        <p><strong>Restricted (Not Updated):</strong> ${restrictedCount}</p>
        <p><strong>Failed:</strong> ${failureCount}</p>
        ${failureCount > 0 ? `<p><strong>Failed Numbers:</strong> ${failedNumbers.join(', ')}</p>` : ''}
        <p><strong>Updated Mobile Numbers:</strong></p>
        <ul>
          ${updatedMobiles.map(num => `<li>${num.trim()}</li>`).join('')}
        </ul>
      `;
      
      // Send email to recipients
      const emailNotificationSent = await sendEmailNotification(emailSubject, emailHtml);
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: mobileNumbers.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

/**
 * ============================================
 * DAILY SUMMARY REPORTER FUNCTIONS
 * ============================================
 */

/**
 * Get summary data for today
 */
async function getSummaryData() {
  const summary = {
    numbers: {},
    sims: {},
    timestamp: new Date().toISOString()
  };

  try {
    const connection = await connectionPool.getConnection();

    try {
      // Get today's date range
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

      // Query mobile numbers logs grouped by USERNAME and STATUS_AFTER
      const numbersQuery = `
        SELECT 
          USERNAME,
          STATUS_AFTER,
          COUNT(*) as COUNT,
          COUNT(DISTINCT MOBILE_NUMBER) as UNIQUE_COUNT
        FROM ZAINSUPPORTNUMLOGS
        WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD') 
          AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD')
        GROUP BY USERNAME, STATUS_AFTER
        ORDER BY USERNAME, STATUS_AFTER
      `;

      const numbersResult = await connection.execute(numbersQuery, {
        startDate: formatDateForOracle(startOfDay),
        endDate: formatDateForOracle(endOfDay)
      });

      // Process numbers data
      if (numbersResult.rows.length > 0) {
        numbersResult.rows.forEach(row => {
          const [username, status, count, uniqueCount] = row;
          const key = `${username}|${status}`;
          summary.numbers[key] = {
            username,
            status,
            updates: count,
            numbers: uniqueCount
          };
        });
      }

      // Query SIM logs grouped by USERNAME and STATUS_AFTER
      const simsQuery = `
        SELECT 
          USERNAME,
          STATUS_AFTER,
          COUNT(*) as COUNT,
          COUNT(DISTINCT SIM_IDENTIFIER) as UNIQUE_COUNT
        FROM ZAIN_SUPPORT_SIMS_LOGS
        WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD') 
          AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD')
        GROUP BY USERNAME, STATUS_AFTER
        ORDER BY USERNAME, STATUS_AFTER
      `;

      const simsResult = await connection.execute(simsQuery, {
        startDate: formatDateForOracle(startOfDay),
        endDate: formatDateForOracle(endOfDay)
      });

      // Process SIMs data
      if (simsResult.rows.length > 0) {
        simsResult.rows.forEach(row => {
          const [username, status, count, uniqueCount] = row;
          const key = `${username}|${status}`;
          if (summary.sims[key]) {
            summary.sims[key].updates += count;
            summary.sims[key].sims += uniqueCount;
          } else {
            summary.sims[key] = {
              username,
              status,
              updates: count,
              sims: uniqueCount
            };
          }
        });
      }
    } finally {
      await connection.close();
    }

    return summary;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error retrieving summary data:`, err.message);
    return null;
  }
}

/**
 * Format date for Oracle query
 */
function formatDateForOracle(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generate HTML email content
 */
function generateEmailHTML(summary) {
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  let numbersHTML = '';
  let simsHTML = '';

  // Group numbers by status for organization
  const numbersByStatus = {};
  const simsByStatus = {};

  // Process numbers
  Object.values(summary.numbers).forEach(item => {
    if (!numbersByStatus[item.status]) {
      numbersByStatus[item.status] = [];
    }
    numbersByStatus[item.status].push(item);
  });

  // Process SIMs
  Object.values(summary.sims).forEach(item => {
    if (!simsByStatus[item.status]) {
      simsByStatus[item.status] = [];
    }
    simsByStatus[item.status].push(item);
  });

  // Generate numbers table
  if (Object.keys(numbersByStatus).length > 0) {
    numbersHTML = `
      <h3 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">Mobile Numbers Updates</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #3498db; color: white;">
            <th style="padding: 12px; text-align: left; border: 1px solid #bdc3c7;">Status</th>
            <th style="padding: 12px; text-align: left; border: 1px solid #bdc3c7;">User</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #bdc3c7;">Numbers Updated</th>
          </tr>
        </thead>
        <tbody>
    `;

    Object.keys(numbersByStatus).sort().forEach(status => {
      numbersByStatus[status].forEach(item => {
        numbersHTML += `
          <tr style="border: 1px solid #ecf0f1;">
            <td style="padding: 10px; border: 1px solid #ecf0f1; font-weight: bold; background-color: #f8f9fa;">${status}</td>
            <td style="padding: 10px; border: 1px solid #ecf0f1;">${item.username}</td>
            <td style="padding: 10px; border: 1px solid #ecf0f1; text-align: center; background-color: #e8f4f8;">${item.numbers}</td>
          </tr>
        `;
      });
    });

    numbersHTML += `
        </tbody>
      </table>
    `;
  }

  // Generate SIMs table
  if (Object.keys(simsByStatus).length > 0) {
    simsHTML = `
      <h3 style="color: #2c3e50; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">SIM Cards Updates</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #27ae60; color: white;">
            <th style="padding: 12px; text-align: left; border: 1px solid #bdc3c7;">Status</th>
            <th style="padding: 12px; text-align: left; border: 1px solid #bdc3c7;">User</th>
            <th style="padding: 12px; text-align: center; border: 1px solid #bdc3c7;">SIMs Updated</th>
          </tr>
        </thead>
        <tbody>
    `;

    Object.keys(simsByStatus).sort().forEach(status => {
      simsByStatus[status].forEach(item => {
        simsHTML += `
          <tr style="border: 1px solid #ecf0f1;">
            <td style="padding: 10px; border: 1px solid #ecf0f1; font-weight: bold; background-color: #f8f9fa;">${status}</td>
            <td style="padding: 10px; border: 1px solid #ecf0f1;">${item.username}</td>
            <td style="padding: 10px; border: 1px solid #ecf0f1; text-align: center; background-color: #e8f8f4;">${item.sims}</td>
          </tr>
        `;
      });
    });

    simsHTML += `
        </tbody>
      </table>
    `;
  }

  // Calculate totals
  let totalNumbers = 0;
  let totalSims = 0;
  Object.values(summary.numbers).forEach(item => {
    totalNumbers += item.numbers;
  });
  Object.values(summary.sims).forEach(item => {
    totalSims += item.sims;
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f5f7fa;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background-color: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          border-radius: 6px;
          margin-bottom: 20px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
        }
        .header p {
          margin: 5px 0 0 0;
          font-size: 14px;
          opacity: 0.9;
        }
        .summary-stats {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
          margin-bottom: 20px;
        }
        .stat-box {
          background-color: #f8f9fa;
          padding: 15px;
          border-radius: 6px;
          border-left: 4px solid #3498db;
        }
        .stat-box.sims {
          border-left-color: #27ae60;
        }
        .stat-box h4 {
          margin: 0 0 10px 0;
          color: #2c3e50;
          font-size: 14px;
        }
        .stat-box .value {
          font-size: 28px;
          font-weight: bold;
          color: #3498db;
        }
        .stat-box.sims .value {
          color: #27ae60;
        }
        .note {
          background-color: #fff3cd;
          border-left: 4px solid #ffc107;
          padding: 12px;
          margin-top: 20px;
          border-radius: 4px;
          font-size: 13px;
          color: #856404;
        }
        .footer {
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #ecf0f1;
          font-size: 12px;
          color: #7f8c8d;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📊 Daily Status Update Summary</h1>
          <p>${today}</p>
        </div>

        <div class="summary-stats">
          <div class="stat-box">
            <h4>📱 Total Numbers Updated</h4>
            <div class="value">${totalNumbers}</div>
          </div>
          <div class="stat-box sims">
            <h4>💳 Total SIMs Updated</h4>
            <div class="value">${totalSims}</div>
          </div>
        </div>

        ${numbersHTML}
        ${simsHTML}

        <div class="note">
          <strong>ℹ️ Note:</strong> This report is auto-generated and sent every 5 minutes. It shows all updates made today grouped by status and user.
        </div>

        <div class="footer">
          <p>Generated at: ${new Date().toLocaleString()}</p>
          <p>Oracle Status Updater - Daily Summary Reporter</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

/**
 * Send summary email
 */
async function sendSummaryEmail(summary) {
  try {
    const connection = await connectionPool.getConnection();

    try {
      // Fetch all recipient emails from database
      const query = `SELECT EMAIL FROM RECIPIENT_EMAILS ORDER BY EMAIL`;
      const result = await connection.execute(query);
      const recipients = result.rows.map(row => row[0]);

      if (recipients.length === 0) {
        console.log(`[${new Date().toISOString()}] ℹ️  No recipient emails configured. Skipping email notification.`);
        return false;
      }

      // Check if there's any data to report
      const hasData = Object.keys(summary.numbers).length > 0 || Object.keys(summary.sims).length > 0;
      
      if (!hasData) {
        console.log(`[${new Date().toISOString()}] ℹ️  No updates recorded today. Skipping email notification.`);
        return false;
      }

      const htmlContent = generateEmailHTML(summary);

      const mailOptions = {
        from: emailConfig.auth.user,
        to: recipients.join(','),
        subject: `Daily Summary: Status Updates - ${new Date().toLocaleDateString()}`,
        html: htmlContent
      };

      console.log(`[${new Date().toISOString()}] Sending summary email to ${recipients.length} recipient(s)...`);
      const info = await transporter.sendMail(mailOptions);
      console.log(`[${new Date().toISOString()}] ✓ Summary email sent successfully`);
      return true;
    } finally {
      await connection.close();
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to send summary email:`, err.message);
    return false;
  }
}

/**
 * Run the reporter
 */
async function runSummaryReporter() {
  try {
    console.log(`[${new Date().toISOString()}] ▶️  Running daily summary report...`);
    const summary = await getSummaryData();
    
    if (summary) {
      await sendSummaryEmail(summary);
    }
    
    console.log(`[${new Date().toISOString()}] ✓ Daily summary report completed.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error in summary reporter:`, err.message);
  }
}

/**
 * Schedule the reporter to run every 5 minutes
 */
function startSummaryReporter() {
  const INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

  console.log(`[${new Date().toISOString()}] 📧 Scheduling daily summary reporter to run every 5 minutes...`);

  // Run immediately on start
  runSummaryReporter();

  // Then schedule to run every 5 minutes
  setInterval(() => {
    runSummaryReporter();
  }, INTERVAL);
}

/**
 * ============================================
 * FAILED UPDATES REPORTER - EXCEL EXPORT
 * ============================================
 */

/**
 * Get failed numbers and SIMs data for today
 */
async function getFailedUpdatesData() {
  const data = {
    numbers: [],
    sims: [],
    numberSummary: {},
    simSummary: {},
    timestamp: new Date().toISOString()
  };

  let connection;
  try {
    connection = await connectionPool.getConnection();

    try {
      // Get today's date range
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

      const startDateStr = formatDateForOracle(startOfDay);
      const endDateStr = formatDateForOracle(endOfDay);

      console.log(`[${new Date().toISOString()}] Querying failed numbers from ${startDateStr} to ${endDateStr}`);

      // Query failed numbers
      try {
        const numbersQuery = `
          SELECT MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT
          FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
          WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD') 
            AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD')
          ORDER BY USERNAME, FAILURE_REASON, CREATED_AT DESC
        `;

        const numbersResult = await connection.execute(numbersQuery, {
          startDate: startDateStr,
          endDate: endDateStr
        });

        console.log(`[${new Date().toISOString()}] Found ${numbersResult.rows.length} failed numbers`);

        // Process numbers data
        if (numbersResult.rows && numbersResult.rows.length > 0) {
          numbersResult.rows.forEach(row => {
            const [mobileNumber, failureReason, username, createdAt] = row;
            data.numbers.push({
              mobileNumber: mobileNumber || '',
              failureReason: failureReason || '',
              username: username || '',
              createdAt: createdAt
            });

            // Build summary
            const key = `${username}|${failureReason}`;
            if (!data.numberSummary[key]) {
              data.numberSummary[key] = {
                username: username || '',
                failureReason: failureReason || '',
                count: 0
              };
            }
            data.numberSummary[key].count++;
          });
        }
      } catch (numErr) {
        console.error(`[${new Date().toISOString()}] Error querying failed numbers:`, numErr.message);
      }

      console.log(`[${new Date().toISOString()}] Querying failed SIMs from ${startDateStr} to ${endDateStr}`);

      // Query failed SIMs
      try {
        const simsQuery = `
          SELECT SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT
          FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
          WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD') 
            AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD')
          ORDER BY USERNAME, FAILURE_REASON, CREATED_AT DESC
        `;

        const simsResult = await connection.execute(simsQuery, {
          startDate: startDateStr,
          endDate: endDateStr
        });

        console.log(`[${new Date().toISOString()}] Found ${simsResult.rows.length} failed SIMs`);

        // Process SIMs data
        if (simsResult.rows && simsResult.rows.length > 0) {
          simsResult.rows.forEach(row => {
            const [simIdentifier, failureReason, username, createdAt] = row;
            data.sims.push({
              simIdentifier: simIdentifier || '',
              failureReason: failureReason || '',
              username: username || '',
              createdAt: createdAt
            });

            // Build summary
            const key = `${username}|${failureReason}`;
            if (!data.simSummary[key]) {
              data.simSummary[key] = {
                username: username || '',
                failureReason: failureReason || '',
                count: 0
              };
            }
            data.simSummary[key].count++;
          });
        }
      } catch (simErr) {
        console.error(`[${new Date().toISOString()}] Error querying failed SIMs:`, simErr.message);
      }
    } finally {
      await connection.close();
    }

    return data;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error retrieving failed updates data:`, err.message);
    return data; // Return empty data instead of null
  }
}

/**
 * Generate Excel file for failed numbers
 */
async function generateFailedNumbersExcel(data) {
  try {
    const workbook = new ExcelJS.Workbook();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'User', key: 'username', width: 15 },
      { header: 'Failure Reason', key: 'failureReason', width: 30 },
      { header: 'Count', key: 'count', width: 10 }
    ];

    // Style summary header
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3498DB' } };
    summarySheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center' };

    // Add summary data
    Object.values(data.numberSummary).forEach(item => {
      summarySheet.addRow(item);
    });

    // Detail sheet
    const detailSheet = workbook.addWorksheet('Details');
    detailSheet.columns = [
      { header: 'Mobile Number', key: 'mobileNumber', width: 20 },
      { header: 'Failure Reason', key: 'failureReason', width: 30 },
      { header: 'Created By', key: 'username', width: 15 },
      { header: 'Date/Time', key: 'createdAt', width: 20 }
    ];

    // Style detail header
    detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3498DB' } };
    detailSheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center' };

    // Add detail data
    data.numbers.forEach(item => {
      detailSheet.addRow({
        mobileNumber: item.mobileNumber,
        failureReason: item.failureReason,
        username: item.username,
        createdAt: item.createdAt ? new Date(item.createdAt).toLocaleString() : ''
      });
    });

    // Auto-fit columns
    summarySheet.columns.forEach(column => {
      column.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
    });
    detailSheet.columns.forEach(column => {
      column.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
    });

    // Save to temp file
    const fileName = `failed-numbers-${new Date().toISOString().split('T')[0]}-${Date.now()}.xlsx`;
    const filePath = path.join(os.tmpdir(), fileName);
    await workbook.xlsx.writeFile(filePath);

    return filePath;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error generating failed numbers Excel:`, err.message);
    return null;
  }
}

/**
 * Generate Excel file for failed SIMs
 */
async function generateFailedSimsExcel(data) {
  try {
    const workbook = new ExcelJS.Workbook();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'User', key: 'username', width: 15 },
      { header: 'Failure Reason', key: 'failureReason', width: 30 },
      { header: 'Count', key: 'count', width: 10 }
    ];

    // Style summary header
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };
    summarySheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center' };

    // Add summary data
    Object.values(data.simSummary).forEach(item => {
      summarySheet.addRow(item);
    });

    // Detail sheet
    const detailSheet = workbook.addWorksheet('Details');
    detailSheet.columns = [
      { header: 'SIM Identifier', key: 'simIdentifier', width: 20 },
      { header: 'Failure Reason', key: 'failureReason', width: 30 },
      { header: 'Created By', key: 'username', width: 15 },
      { header: 'Date/Time', key: 'createdAt', width: 20 }
    ];

    // Style detail header
    detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    detailSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };
    detailSheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center' };

    // Add detail data
    data.sims.forEach(item => {
      detailSheet.addRow({
        simIdentifier: item.simIdentifier,
        failureReason: item.failureReason,
        username: item.username,
        createdAt: item.createdAt ? new Date(item.createdAt).toLocaleString() : ''
      });
    });

    // Auto-fit columns
    summarySheet.columns.forEach(column => {
      column.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
    });
    detailSheet.columns.forEach(column => {
      column.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
    });

    // Save to temp file
    const fileName = `failed-sims-${new Date().toISOString().split('T')[0]}-${Date.now()}.xlsx`;
    const filePath = path.join(os.tmpdir(), fileName);
    await workbook.xlsx.writeFile(filePath);

    return filePath;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error generating failed SIMs Excel:`, err.message);
    return null;
  }
}

/**
 * Send failed updates email with summary tables
 */
async function sendFailedUpdatesEmail(data) {
  let numFilePath, simFilePath;
  let connection;

  try {
    // Check if there's any failed data
    const hasFailures = data.numbers.length > 0 || data.sims.length > 0;
    
    if (!hasFailures) {
      console.log(`[${new Date().toISOString()}] ✓ No failed updates today. Skipping email.`);
      return false;
    }

    console.log(`[${new Date().toISOString()}] Found failures - numbers: ${data.numbers.length}, sims: ${data.sims.length}`);

    // Fetch recipient emails
    connection = await connectionPool.getConnection();
    
    try {
      const recipientQuery = `SELECT EMAIL FROM RECIPIENT_EMAILS ORDER BY EMAIL`;
      const recipientResult = await connection.execute(recipientQuery);
      const recipients = recipientResult.rows.map(row => row[0]);

      if (recipients.length === 0) {
        console.log(`[${new Date().toISOString()}] ℹ️  No recipient emails configured. Skipping failed updates email.`);
        return false;
      }

      console.log(`[${new Date().toISOString()}] Found ${recipients.length} recipient(s): ${recipients.join(', ')}`);

      // Generate Excel files
      console.log(`[${new Date().toISOString()}] Generating Excel files...`);
      numFilePath = await generateFailedNumbersExcel(data);
      simFilePath = await generateFailedSimsExcel(data);

      console.log(`[${new Date().toISOString()}] Numbers file: ${numFilePath ? 'OK' : 'FAILED'}`);
      console.log(`[${new Date().toISOString()}] SIMs file: ${simFilePath ? 'OK' : 'FAILED'}`);

      // Calculate totals
      const totalNumbers = data.numbers.length;
      const totalSims = data.sims.length;

      // Build summary tables HTML
      let numbersSummaryHTML = '';
      if (Object.keys(data.numberSummary).length > 0) {
        numbersSummaryHTML = `
          <h3 style="color: #e74c3c; margin-top: 20px;">Failed Numbers Summary</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <tr style="background-color: #e74c3c; color: white;">
              <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">User</th>
              <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">Failure Reason</th>
              <th style="padding: 10px; border: 1px solid #ccc; text-align: center;">Count</th>
            </tr>
            ${Object.values(data.numberSummary).map(item => `
              <tr>
                <td style="padding: 10px; border: 1px solid #ccc;">${item.username}</td>
                <td style="padding: 10px; border: 1px solid #ccc;">${item.failureReason}</td>
                <td style="padding: 10px; border: 1px solid #ccc; text-align: center; font-weight: bold;">${item.count}</td>
              </tr>
            `).join('')}
          </table>
        `;
      }

      let simsSummaryHTML = '';
      if (Object.keys(data.simSummary).length > 0) {
        simsSummaryHTML = `
          <h3 style="color: #e74c3c; margin-top: 20px;">Failed SIMs Summary</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <tr style="background-color: #e74c3c; color: white;">
              <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">User</th>
              <th style="padding: 10px; border: 1px solid #ccc; text-align: left;">Failure Reason</th>
              <th style="padding: 10px; border: 1px solid #ccc; text-align: center;">Count</th>
            </tr>
            ${Object.values(data.simSummary).map(item => `
              <tr>
                <td style="padding: 10px; border: 1px solid #ccc;">${item.username}</td>
                <td style="padding: 10px; border: 1px solid #ccc;">${item.failureReason}</td>
                <td style="padding: 10px; border: 1px solid #ccc; text-align: center; font-weight: bold;">${item.count}</td>
              </tr>
            `).join('')}
          </table>
        `;
      }

      // Build email content
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; color: #333; background-color: #f5f7fa; }
            .container { max-width: 900px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%); color: white; padding: 20px; border-radius: 6px; margin-bottom: 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .header p { margin: 5px 0 0 0; font-size: 14px; opacity: 0.9; }
            .summary-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
            .stat-box { background-color: #f8f9fa; padding: 15px; border-radius: 6px; border-left: 4px solid #e74c3c; text-align: center; }
            .stat-box h4 { margin: 0 0 10px 0; color: #2c3e50; font-size: 14px; }
            .stat-box .value { font-size: 28px; font-weight: bold; color: #e74c3c; }
            .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ecf0f1; font-size: 12px; color: #7f8c8d; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>⚠️ Failed Updates Report</h1>
              <p>${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
            </div>

            <div class="summary-stats">
              <div class="stat-box">
                <h4>📱 Failed Numbers</h4>
                <div class="value">${totalNumbers}</div>
              </div>
              <div class="stat-box">
                <h4>💳 Failed SIMs</h4>
                <div class="value">${totalSims}</div>
              </div>
            </div>

            ${numbersSummaryHTML}
            ${simsSummaryHTML}

            <div class="footer">
              <p>Generated at: ${new Date().toLocaleString()}</p>
              <p>Oracle Status Updater - Failed Updates Reporter (5-minute interval)</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const attachments = [];
      if (numFilePath && fs.existsSync(numFilePath)) {
        attachments.push({
          filename: `failed-numbers-${new Date().toISOString().split('T')[0]}.xlsx`,
          path: numFilePath
        });
      }
      if (simFilePath && fs.existsSync(simFilePath)) {
        attachments.push({
          filename: `failed-sims-${new Date().toISOString().split('T')[0]}.xlsx`,
          path: simFilePath
        });
      }

      const mailOptions = {
        from: emailConfig.auth.user,
        to: recipients.join(','),
        subject: `⚠️ Failed Updates Report - ${new Date().toLocaleDateString()} (${totalNumbers} numbers, ${totalSims} SIMs)`,
        html: htmlContent,
        attachments: attachments
      };

      console.log(`[${new Date().toISOString()}] 📤 Sending failed updates email with ${attachments.length} attachment(s)...`);
      const info = await transporter.sendMail(mailOptions);
      console.log(`[${new Date().toISOString()}] ✓ Failed updates email sent successfully`);
      console.log(`[${new Date().toISOString()}] Email response:`, info.response);
      return true;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to send failed updates email:`, err.message);
    console.error(`[${new Date().toISOString()}] Stack:`, err.stack);
    return false;
  } finally {
    // Clean up temp files
    if (numFilePath && fs.existsSync(numFilePath)) {
      try {
        fs.unlinkSync(numFilePath);
        console.log(`[${new Date().toISOString()}] Cleaned up temp file: ${numFilePath}`);
      } catch (err) {
        console.warn(`[${new Date().toISOString()}] Warning: Could not delete temp file ${numFilePath}`);
      }
    }
    if (simFilePath && fs.existsSync(simFilePath)) {
      try {
        fs.unlinkSync(simFilePath);
        console.log(`[${new Date().toISOString()}] Cleaned up temp file: ${simFilePath}`);
      } catch (err) {
        console.warn(`[${new Date().toISOString()}] Warning: Could not delete temp file ${simFilePath}`);
      }
    }
  }
}

/**
 * Run the failed updates reporter
 */
async function runFailedUpdatesReporter() {
  try {
    console.log(`[${new Date().toISOString()}] ▶️  Running failed updates report...`);
    const data = await getFailedUpdatesData();
    
    if (data && (data.numbers.length > 0 || data.sims.length > 0)) {
      console.log(`[${new Date().toISOString()}] Found failures: ${data.numbers.length} numbers, ${data.sims.length} sims`);
      await sendFailedUpdatesEmail(data);
    } else {
      console.log(`[${new Date().toISOString()}] No failures to report today.`);
    }
    
    console.log(`[${new Date().toISOString()}] ✓ Failed updates report completed.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error in failed updates reporter:`, err.message);
    console.error(`[${new Date().toISOString()}] Stack:`, err.stack);
  }
}

/**
 * Schedule failed updates reporter to run every 5 minutes
 */
function startFailedUpdatesReporter() {
  const INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

  console.log(`[${new Date().toISOString()}] 📊 Scheduling failed updates reporter to run every 5 minutes...`);

  // Run immediately on start
  runFailedUpdatesReporter();

  // Then schedule to run every 5 minutes
  setInterval(() => {
    runFailedUpdatesReporter();
  }, INTERVAL);
}

/**
 * Get dashboard statistics
 */
app.get('/api/dashboard-stats', requireAuth, async (req, res) => {
  // Only admins can access dashboard
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin access required.',
      error: 'ADMIN_ONLY'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const stats = {
      totalStaff: 0,
      totalAdmins: 0,
      totalUpdatedNumbers: 0,
      totalUpdatedSims: 0,
      totalFailedNumbers: 0,
      totalFailedSims: 0
    };

    // Get total staff count (only staff role, excluding admins)
    try {
      const staffQuery = `SELECT COUNT(*) as cnt FROM ZAINSUPPORTUSERS WHERE ACTIVE = 1 AND ROLE = 'staff'`;
      const staffResult = await connection.execute(staffQuery);
      stats.totalStaff = staffResult.rows[0][0];
    } catch (e) {
      console.error('Error getting staff count:', e.message);
      stats.totalStaff = 0;
    }

    // Get total admin count
    try {
      const adminQuery = `SELECT COUNT(*) as cnt FROM ZAINSUPPORTUSERS WHERE ACTIVE = 1 AND ROLE = 'admin'`;
      const adminResult = await connection.execute(adminQuery);
      stats.totalAdmins = adminResult.rows[0][0];
    } catch (e) {
      console.error('Error getting admin count:', e.message);
      stats.totalAdmins = 0;
    }

    // Get total updated numbers
    try {
      const numQuery = `SELECT COUNT(*) as cnt FROM ZAINSUPPORTNUMLOGS`;
      const numResult = await connection.execute(numQuery);
      stats.totalUpdatedNumbers = numResult.rows[0][0];
    } catch (e) {
      console.error('Error getting total updated numbers:', e.message);
      stats.totalUpdatedNumbers = 0;
    }

    // Get total updated SIMs
    try {
      const simQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_SIMS_LOGS`;
      const simResult = await connection.execute(simQuery);
      stats.totalUpdatedSims = simResult.rows[0][0];
    } catch (e) {
      console.error('Error getting total updated SIMs:', e.message);
      stats.totalUpdatedSims = 0;
    }

    // Get total failed numbers
    try {
      const failNumQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_NUM_LOGS`;
      const failNumResult = await connection.execute(failNumQuery);
      stats.totalFailedNumbers = failNumResult.rows[0][0];
    } catch (e) {
      console.error('Error getting failed numbers count:', e.message);
      stats.totalFailedNumbers = 0;
    }

    // Get total failed SIMs
    try {
      const failSimQuery = `SELECT COUNT(*) as cnt FROM ZAIN_SUPPORT_FAILED_SIM_LOGS`;
      const failSimResult = await connection.execute(failSimQuery);
      stats.totalFailedSims = failSimResult.rows[0][0];
    } catch (e) {
      console.error('Error getting failed SIMs count:', e.message);
      stats.totalFailedSims = 0;
    }

    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error fetching dashboard statistics',
      error: err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

/**
 * Get dashboard chart data (last 30 days)
 */
app.get('/api/dashboard-charts', requireAuth, async (req, res) => {
  // Only admins can access dashboard
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin access required.',
      error: 'ADMIN_ONLY'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const chartData = {
      dates: [],
      numbersUpdated: [],
      numbersFailed: [],
      simsUpdated: [],
      simsFailed: []
    };

    // Get current month data with separate queries for each table
    let nums_updated_data = {};
    let nums_failed_data = {};
    let sims_updated_data = {};
    let sims_failed_data = {};

    try {
      // Get updated numbers by date
      const numQuery = `
        SELECT TO_CHAR(TRUNC(UPDATE_TIME), 'YYYY-MM-DD') as log_date, COUNT(*) as cnt
        FROM ZAINSUPPORTNUMLOGS
        WHERE TRUNC(UPDATE_TIME) >= TRUNC(SYSDATE, 'MM')
        GROUP BY TRUNC(UPDATE_TIME)
      `;
      const numResult = await connection.execute(numQuery);
      if (numResult.rows && numResult.rows.length > 0) {
        numResult.rows.forEach(row => {
          nums_updated_data[row[0]] = Number(row[1]) || 0;
        });
      }
    } catch (e) {
      console.error('Error getting updated numbers:', e.message);
    }

    try {
      // Get failed numbers by date
      const failNumQuery = `
        SELECT TO_CHAR(TRUNC(CREATED_AT), 'YYYY-MM-DD') as log_date, COUNT(*) as cnt
        FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
        WHERE TRUNC(CREATED_AT) >= TRUNC(SYSDATE, 'MM')
        GROUP BY TRUNC(CREATED_AT)
      `;
      const failNumResult = await connection.execute(failNumQuery);
      if (failNumResult.rows && failNumResult.rows.length > 0) {
        failNumResult.rows.forEach(row => {
          nums_failed_data[row[0]] = Number(row[1]) || 0;
        });
      }
    } catch (e) {
      console.error('Error getting failed numbers:', e.message);
    }

    try {
      // Get updated SIMs by date
      const simQuery = `
        SELECT TO_CHAR(TRUNC(UPDATE_TIME), 'YYYY-MM-DD') as log_date, COUNT(*) as cnt
        FROM ZAIN_SUPPORT_SIMS_LOGS
        WHERE TRUNC(UPDATE_TIME) >= TRUNC(SYSDATE, 'MM')
        GROUP BY TRUNC(UPDATE_TIME)
      `;
      const simResult = await connection.execute(simQuery);
      if (simResult.rows && simResult.rows.length > 0) {
        simResult.rows.forEach(row => {
          sims_updated_data[row[0]] = Number(row[1]) || 0;
        });
      }
    } catch (e) {
      console.error('Error getting updated SIMs:', e.message);
    }

    try {
      // Get failed SIMs by date
      const failSimQuery = `
        SELECT TO_CHAR(TRUNC(CREATED_AT), 'YYYY-MM-DD') as log_date, COUNT(*) as cnt
        FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
        WHERE TRUNC(CREATED_AT) >= TRUNC(SYSDATE, 'MM')
        GROUP BY TRUNC(CREATED_AT)
      `;
      const failSimResult = await connection.execute(failSimQuery);
      if (failSimResult.rows && failSimResult.rows.length > 0) {
        failSimResult.rows.forEach(row => {
          sims_failed_data[row[0]] = Number(row[1]) || 0;
        });
      }
    } catch (e) {
      console.error('Error getting failed SIMs:', e.message);
    }

    // Generate dates for current month up to today and populate chart data
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    
    for (let d = new Date(firstDay); d <= today; d.setDate(d.getDate() + 1)) {
      // Format date as YYYY-MM-DD in local timezone (matching Oracle output)
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      chartData.dates.push(dateStr);
      chartData.numbersUpdated.push(nums_updated_data[dateStr] || 0);
      chartData.numbersFailed.push(nums_failed_data[dateStr] || 0);
      chartData.simsUpdated.push(sims_updated_data[dateStr] || 0);
      chartData.simsFailed.push(sims_failed_data[dateStr] || 0);
    }

    try {
      res.json({
        success: true,
        data: chartData
      });
    } catch (queryErr) {
      console.error('Dashboard chart data preparation error:', queryErr.message);
      res.json({
        success: true,
        data: chartData
      });
    }
  } catch (err) {
    console.error('Dashboard charts error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error fetching dashboard chart data',
      error: err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

// Temporary directory for storing generated Excel files
const tempDir = path.join(os.tmpdir(), 'zain-excel-reports');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Define specific columns for each table
const tableColumnMappings = {
  'updated_numbers': ['MOBILE_NUMBER', 'STATUS_BEFORE', 'STATUS_AFTER', 'USERNAME', 'UPDATE_TIME', 'CREATED_AT'],
  'failed_numbers': ['MOBILE_NUMBER', 'FAILURE_REASON', 'USERNAME', 'CREATED_AT'],
  'updated_sims': ['SIM_IDENTIFIER', 'STATUS_BEFORE', 'STATUS_AFTER', 'USERNAME', 'UPDATE_TIME', 'CREATED_AT'],
  'failed_sims': ['SIM_IDENTIFIER', 'FAILURE_REASON', 'USERNAME', 'CREATED_AT']
};

// Function to get column list for SQL query
function getColumnList(dataType) {
  const columns = tableColumnMappings[dataType];
  return columns ? columns.join(', ') : '*';
}

// Helper function to format column names for Excel headers
function formatColumnName(dbColumnName) {
  return dbColumnName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Generate Excel Report
app.get('/api/generate-excel', requireAuth, async (req, res) => {
  let connection;
  try {
    const { fromDate, toDate, dataType } = req.query;
    
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'From date and to date are required' });
    }
    
    connection = await connectionPool.getConnection();
    
    let data = [];
    let tableName = '';
    let dateColumn = '';
    
    // Determine which table and column to use
    switch (dataType) {
      case 'updated_numbers':
        tableName = 'ZAINSUPPORTNUMLOGS';
        dateColumn = 'UPDATE_TIME';
        break;
      case 'failed_numbers':
        tableName = 'ZAIN_SUPPORT_FAILED_NUM_LOGS';
        dateColumn = 'CREATED_AT';
        break;
      case 'updated_sims':
        tableName = 'ZAIN_SUPPORT_SIMS_LOGS';
        dateColumn = 'UPDATE_TIME';
        break;
      case 'failed_sims':
        tableName = 'ZAIN_SUPPORT_FAILED_SIM_LOGS';
        dateColumn = 'CREATED_AT';
        break;
      case 'all':
        // Will handle all data separately
        break;
      default:
        return res.status(400).json({ error: 'Invalid data type' });
    }
    
    if (dataType === 'all') {
      // Fetch all data types
      const queries = [
        { name: 'updated_numbers', table: 'ZAINSUPPORTNUMLOGS', dateCol: 'UPDATE_TIME' },
        { name: 'failed_numbers', table: 'ZAIN_SUPPORT_FAILED_NUM_LOGS', dateCol: 'CREATED_AT' },
        { name: 'updated_sims', table: 'ZAIN_SUPPORT_SIMS_LOGS', dateCol: 'UPDATE_TIME' },
        { name: 'failed_sims', table: 'ZAIN_SUPPORT_FAILED_SIM_LOGS', dateCol: 'CREATED_AT' }
      ];
      
      for (const query of queries) {
        const columnList = getColumnList(query.name);
        const result = await connection.execute(
          `SELECT ${columnList} FROM ${query.table} WHERE TRUNC(${query.dateCol}) >= TO_DATE(:fromDate, 'YYYY-MM-DD') AND TRUNC(${query.dateCol}) <= TO_DATE(:toDate, 'YYYY-MM-DD') ORDER BY ${query.dateCol} DESC`,
          { fromDate, toDate }
        );
        data.push({ type: query.name, records: result.rows || [] });
      }
    } else {
      // Fetch single data type
      const columnList = getColumnList(dataType);
      const result = await connection.execute(
        `SELECT ${columnList} FROM ${tableName} WHERE TRUNC(${dateColumn}) >= TO_DATE(:fromDate, 'YYYY-MM-DD') AND TRUNC(${dateColumn}) <= TO_DATE(:toDate, 'YYYY-MM-DD') ORDER BY ${dateColumn} DESC`,
        { fromDate, toDate }
      );
      data = result.rows || [];
    }
    
    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    
    if (dataType === 'all') {
      // Create multiple sheets
      data.forEach(({ type, records }) => {
        const worksheet = workbook.addWorksheet(type);
        
        if (records.length > 0) {
          try {
            // Get predefined columns for this table type
            const columnKeys = tableColumnMappings[type] || [];
            
            if (columnKeys.length === 0) {
              console.warn(`No column mapping found for type ${type}`);
              return;
            }
            
            // Define columns with proper structure
            const columns = columnKeys.map(key => ({
              header: formatColumnName(key),
              key: key,
              width: 18
            }));
            
            worksheet.columns = columns;
            
            // Style header row (row 1 is auto-created by worksheet.columns)
            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0084D4' } };
            worksheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
            
            // Add data rows using array format with values in column order
            records.forEach(record => {
              const rowValues = columnKeys.map(key => record[key] || '');
              worksheet.addRow(rowValues);
            });
            
            console.log(`Successfully added ${records.length} rows to sheet ${type}`);
          } catch (sheetErr) {
            console.error(`Error processing sheet ${type}:`, sheetErr.message);
          }
        }
      });
    } else {
      // Single sheet
      const worksheet = workbook.addWorksheet(dataType);
      
      try {
        if (data.length > 0) {
          // Get predefined columns for this data type
          const columnKeys = tableColumnMappings[dataType] || [];
          
          if (columnKeys.length === 0) {
            console.warn(`No column mapping found for type ${dataType}`);
          } else {
            // Define columns with proper structure
            const columns = columnKeys.map(key => ({
              header: formatColumnName(key),
              key: key,
              width: 18
            }));
            
            worksheet.columns = columns;
            
            // Style header row (row 1 is auto-created by worksheet.columns)
            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0084D4' } };
            worksheet.getRow(1).alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
            
            // Add data rows using array format with values in column order
            data.forEach(record => {
              const rowValues = columnKeys.map(key => record[key] || '');
              worksheet.addRow(rowValues);
            });
            
            console.log(`Successfully added ${data.length} data rows to sheet`);
          }
        } else {
          console.log('No data to add to spreadsheet');
        }
      } catch (sheetErr) {
        console.error('Error processing single sheet:', sheetErr.message);
      }
    }
    
    // Generate unique file ID
    const fileId = `report_${dataType}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const filePath = path.join(tempDir, `${fileId}.xlsx`);
    
    // Write file to temp directory
    await workbook.xlsx.writeFile(filePath);
    
    // Store file info in session for later download
    if (!req.session.generatedFiles) {
      req.session.generatedFiles = {};
    }
    
    req.session.generatedFiles[fileId] = {
      filePath,
      fileName: `report_${dataType}_${fromDate}_to_${toDate}.xlsx`,
      createdAt: Date.now()
    };
    
    res.json({ 
      success: true, 
      fileId,
      message: `Excel file generated successfully with ${Object.values(data).flat().length} records`
    });
    
  } catch (err) {
    console.error('Generate Excel error:', err.message || err);
    console.error('Stack trace:', err.stack);
    res.status(500).json({ error: 'Error generating Excel file', details: err.message });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
});

// Download Excel Report
app.get('/api/download-excel', requireAuth, async (req, res) => {
  try {
    const { fileId } = req.query;
    
    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }
    
    // Check if file exists in session
    if (!req.session.generatedFiles || !req.session.generatedFiles[fileId]) {
      return res.status(404).json({ error: 'File not found or expired. Please generate again.' });
    }
    
    const fileInfo = req.session.generatedFiles[fileId];
    
    if (!fs.existsSync(fileInfo.filePath)) {
      delete req.session.generatedFiles[fileId];
      return res.status(404).json({ error: 'File not found on disk. Please generate again.' });
    }
    
    // Set headers and send file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
    
    const fileStream = fs.createReadStream(fileInfo.filePath);
    fileStream.pipe(res);
    
    // Clean up file after serving
    fileStream.on('end', () => {
      try {
        fs.unlink(fileInfo.filePath, (err) => {
          if (err) console.error('Error deleting temp file:', err);
          else delete req.session.generatedFiles[fileId];
        });
      } catch (e) {
        console.error('Error cleaning up file:', e);
      }
    });
    
  } catch (err) {
    console.error('Download Excel error:', err.message || err);
    res.status(500).json({ error: 'Error downloading Excel file', details: err.message });
  }
});

// Export all database logs to Excel
app.get('/api/export-logs', requireAuth, async (req, res) => {
  let connection;
  try {
    console.log(`\n[${new Date().toISOString()}] 📊 ExportLogs API endpoint called by user: ${req.session.user}`);
    
    connection = await connectionPool.getConnection();
    
    const executeQuery = async (query, tableName) => {
      try {
        const result = await connection.execute(query);
        const columns = result.metaData.map(col => col.name);
        console.log(`[${new Date().toISOString()}] ✓ ${tableName}: ${columns.length} columns, ${result.rows.length} rows`);
        console.log(`[${new Date().toISOString()}]    Columns: ${columns.join(', ')}`);
        return {
          columns: columns,
          rows: result.rows || []
        };
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error querying ${tableName}:`, err.message);
        return { columns: [], rows: [] };
      }
    };

    const [mobileLogs, simLogs, failedMobileLogs, failedSimLogs] = await Promise.all([
      executeQuery('SELECT * FROM ZAINSUPPORTNUMLOGS ORDER BY UPDATE_TIME DESC', 'ZAINSUPPORTNUMLOGS'),
      executeQuery('SELECT * FROM ZAIN_SUPPORT_SIMS_LOGS ORDER BY UPDATE_TIME DESC', 'ZAIN_SUPPORT_SIMS_LOGS'),
      executeQuery('SELECT * FROM ZAIN_SUPPORT_FAILED_NUM_LOGS ORDER BY CREATED_AT DESC', 'ZAIN_SUPPORT_FAILED_NUM_LOGS'),
      executeQuery('SELECT * FROM ZAIN_SUPPORT_FAILED_SIM_LOGS ORDER BY CREATED_AT DESC', 'ZAIN_SUPPORT_FAILED_SIM_LOGS')
    ]);

    // Create workbook
    console.log(`\n[${new Date().toISOString()}] Creating Excel workbook with 4 sheets...\n`);
    const workbook = new ExcelJS.Workbook();

    // Helper function to create sheet with columns
    const createSheet = (sheetName, columns, rows) => {
      if (!columns || columns.length === 0) {
        console.log(`[${new Date().toISOString()}] Skipping ${sheetName} - no columns`);
        return;
      }

      console.log(`[${new Date().toISOString()}] Creating sheet: ${sheetName} with ${columns.length} columns and ${rows.length} rows`);
      const sheet = workbook.addWorksheet(sheetName);

      // Add header row with column names
      sheet.addRow(columns);
      console.log(`[${new Date().toISOString()}]    Added header row: ${columns.join(', ')}`);

      // Add data rows
      let addedCount = 0;
      rows.forEach((row, rowIndex) => {
        try {
          sheet.addRow(row);
          addedCount++;
        } catch (err) {
          console.error(`[${new Date().toISOString()}] Error adding row ${rowIndex + 2}:`, err.message);
        }
      });

      console.log(`[${new Date().toISOString()}] ✓ ${sheetName}: Headers + ${addedCount}/${rows.length} data rows added`);
    };

    // Create sheets with proper column headers
    createSheet('Mobile Numbers', mobileLogs.columns, mobileLogs.rows);
    createSheet('SIM Logs', simLogs.columns, simLogs.rows);
    createSheet('Failed Mobile', failedMobileLogs.columns, failedMobileLogs.rows);
    createSheet('Failed SIM', failedSimLogs.columns, failedSimLogs.rows);

    // Create downloads directory
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('-').slice(0, -1).join('-');
    const filename = `database-logs-${timestamp}.xlsx`;
    const filepath = path.join(downloadsDir, filename);

    // Save workbook
    console.log(`\n[${new Date().toISOString()}] Saving Excel workbook to file...`);
    await workbook.xlsx.writeFile(filepath);
    console.log(`[${new Date().toISOString()}] ✓ File successfully written\n`);

    // Print summary
    const totalRecords = mobileLogs.rows.length + simLogs.rows.length + failedMobileLogs.rows.length + failedSimLogs.rows.length;
    console.log(`[${new Date().toISOString()}] 📊 EXPORT COMPLETED SUCCESSFULLY`);
    console.log(`[${new Date().toISOString()}] ========================================`);
    console.log(`[${new Date().toISOString()}] 📁 File: ${filename}`);
    console.log(`[${new Date().toISOString()}] 📍 Location: downloads/`);
    console.log(`[${new Date().toISOString()}] 📱 Mobile Numbers: ${mobileLogs.columns.length} columns, ${mobileLogs.rows.length} rows`);
    console.log(`[${new Date().toISOString()}] 💳 SIM Logs: ${simLogs.columns.length} columns, ${simLogs.rows.length} rows`);
    console.log(`[${new Date().toISOString()}] ❌ Failed Mobile: ${failedMobileLogs.columns.length} columns, ${failedMobileLogs.rows.length} rows`);
    console.log(`[${new Date().toISOString()}] ❌ Failed SIM: ${failedSimLogs.columns.length} columns, ${failedSimLogs.rows.length} rows`);
    console.log(`[${new Date().toISOString()}] ✅ TOTAL: ${totalRecords} records exported\n`);

    // Send file as download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.download(filepath, filename, (err) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] Error downloading file:`, err);
      }
      // Delete file after download
      try {
        fs.unlinkSync(filepath);
        console.log(`[${new Date().toISOString()}] ✓ File deleted after download`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Error deleting file:`, e);
      }
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error:`, err.message);
    console.error(err);
    res.status(500).json({ success: false, error: 'Error exporting logs', details: err.message });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Error closing connection:`, e);
      }
    }
  }
});

// ===================== SUPPORT QUESTIONS ENDPOINTS =====================

// POST - Ask a new support question (all authenticated users can ask)
app.post('/api/support-questions', requireAuth, async (req, res) => {
  console.log(`[${new Date().toISOString()}] POST /api/support-questions - User: ${req.session.user.username}`);
  console.log(`[${new Date().toISOString()}] Request body:`, JSON.stringify(req.body));
  
  const { title, description } = req.body;

  if (!title || !description) {
    return res.status(400).json({
      success: false,
      message: 'Title and description are required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();
    
    // Check if questions are enabled
    const settingQuery = `SELECT SETTING_VALUE FROM APP_SETTINGS WHERE SETTING_KEY = 'QUESTIONS_ENABLED'`;
    const settingResult = await connection.execute(settingQuery);
    const questionsEnabled = settingResult.rows.length > 0 ? 
      settingResult.rows[0][0].toLowerCase() === 'true' : 
      true;
    
    if (!questionsEnabled) {
      return res.status(403).json({
        success: false,
        message: 'Support questions are currently disabled'
      });
    }

    // First, get the next sequence value
    const seqQuery = `SELECT ZAIN_SUPPORT_ASKED_QUESTIONS_SEQ.NEXTVAL as nextId FROM DUAL`;
    const seqResult = await connection.execute(seqQuery);
    const questionId = seqResult.rows[0][0];
    
    console.log(`[${new Date().toISOString()}] Generated QUESTION_ID: ${questionId}`);

    const insertQuery = `
      INSERT INTO ZAIN_SUPPORT_ASKED_QUESTIONS (QUESTION_ID, TITLE, DESCRIPTION, ASKED_BY, STATUS, ASKED_AT)
      VALUES (:questionId, :title, :description, :askedBy, 'OPEN', SYSDATE)
    `;

    const result = await connection.execute(
      insertQuery,
      {
        questionId: questionId,
        title: title,
        description: description,
        askedBy: req.session.user.username
      },
      { autoCommit: true }
    );

    console.log(`[${new Date().toISOString()}] ✓ New support question created - ID: ${questionId}, Rows affected: ${result.rowsAffected || 1}`);

    // Now retrieve the question to return to frontend
    const retrieveQuery = `
      SELECT QUESTION_ID, TITLE, DESCRIPTION, ASKED_BY, ASKED_AT, STATUS
      FROM ZAIN_SUPPORT_ASKED_QUESTIONS
      WHERE QUESTION_ID = :questionId
    `;
    
    const retrieveResult = await connection.execute(retrieveQuery, { questionId: questionId }, { fetchAsString: ['CLOB'] });
    
    if (retrieveResult.rows.length === 0) {
      console.error(`[${new Date().toISOString()}] ✗ CRITICAL: Question ${questionId} was not found after insertion!`);
      return res.status(500).json({
        success: false,
        message: 'Question created but unable to retrieve from database'
      });
    }
    
    const row = retrieveResult.rows[0];
    const question = {
      questionId: row[0],
      title: row[1],
      description: row[2],
      askedBy: row[3],
      askedAt: row[4] ? new Date(row[4]).toISOString() : new Date().toISOString(),
      status: row[5]
    };
    
    console.log(`[${new Date().toISOString()}] ✓ Question verified in database and returned to frontend`);

    res.json({
      success: true,
      message: 'Question submitted successfully',
      question: question
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error creating question:`, err.message);
    console.error(`[${new Date().toISOString()}] Error code:`, err.errorNum);
    
    let errorMsg = 'Error submitting question: ';
    if (err.errorNum === 955) {
      errorMsg += 'Sequence ZAIN_SUPPORT_ASKED_QUESTIONS_SEQ does not exist';
    } else if (err.errorNum === 942) {
      errorMsg += 'Table ZAIN_SUPPORT_ASKED_QUESTIONS does not exist';
    } else if (err.errorNum === 1400) {
      errorMsg += 'Missing required field (NULL constraint violated)';
    } else {
      errorMsg += `Database error (Code: ${err.errorNum}): ${err.message}`;
    }
    
    res.status(500).json({
      success: false,
      message: errorMsg
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err.message);
      }
    }
  }
});

// GET - Get all support questions with their replies (visible to all)
app.get('/api/support-questions', requireAuth, async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /api/support-questions - User: ${req.session.user.username}`);
  
  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Get all questions
    const questionsQuery = `
      SELECT QUESTION_ID, TITLE, DESCRIPTION, ASKED_BY, ASKED_AT, STATUS
      FROM ZAIN_SUPPORT_ASKED_QUESTIONS
      ORDER BY ASKED_AT DESC
    `;

    const questionsResult = await connection.execute(questionsQuery);
    console.log(`[${new Date().toISOString()}] Found ${questionsResult.rows.length} questions in database`);
    
    const questions = questionsResult.rows.map(row => {
      const askedDate = row[4] ? new Date(row[4]).toISOString() : new Date().toISOString();
      let descText = '';
      if (row[2]) {
        if (typeof row[2] === 'string') {
          descText = row[2];
        } else if (row[2].toString) {
          descText = row[2].toString();
        } else {
          descText = String(row[2]);
        }
      }
      console.log(`[${new Date().toISOString()}] Question - ID: ${row[0]}, Title: ${row[1]}, Description: ${descText ? descText.substring(0, 50) : '(empty)'}`);
      return {
        questionId: row[0],
        title: row[1] ? row[1].toString() : '',
        description: descText,
        askedBy: row[3] ? row[3].toString() : '',
        askedAt: askedDate,
        status: row[5] ? row[5].toString() : 'OPEN'
      };
    });

    // Get all replies for each question
    const repliesQuery = `
      SELECT REPLY_ID, QUESTION_ID, REPLY_TEXT, REPLIED_BY, REPLIED_AT
      FROM SUPPORT_REPLIES
      ORDER BY REPLIED_AT ASC
    `;

    const repliesResult = await connection.execute(repliesQuery);
    console.log(`[${new Date().toISOString()}] Found ${repliesResult.rows.length} replies in database`);
    
    const replies = repliesResult.rows.map(row => {
      const repliedDate = row[4] ? new Date(row[4]).toISOString() : new Date().toISOString();
      let replyText = '';
      if (row[2]) {
        if (typeof row[2] === 'string') {
          replyText = row[2];
        } else if (row[2].toString) {
          replyText = row[2].toString();
        } else {
          replyText = String(row[2]);
        }
      }
      return {
        replyId: row[0],
        questionId: row[1],
        replyText: replyText,
        repliedBy: row[3] ? row[3].toString() : '',
        repliedAt: repliedDate
      };
    });

    // Organize replies by question
    const questionsWithReplies = questions.map(q => ({
      questionId: q.questionId,
      title: q.title,
      description: q.description,
      askedBy: q.askedBy,
      askedAt: q.askedAt,
      status: q.status,
      replies: replies.filter(r => r.questionId === q.questionId).map(r => ({
        replyId: r.replyId,
        questionId: r.questionId,
        replyText: r.replyText,
        repliedBy: r.repliedBy,
        repliedAt: r.repliedAt
      }))
    }));

    console.log(`[${new Date().toISOString()}] ✓ Returning ${questionsWithReplies.length} questions with replies`);

    res.json({
      success: true,
      questions: questionsWithReplies
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Database error in /api/support-questions:`, err.message);
    console.error(`[${new Date().toISOString()}] Error code:`, err.errorNum);
    res.status(500).json({
      success: false,
      message: 'Error fetching questions: Unable to retrieve from database'
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err.message);
      }
    }
  }
});

// DIAGNOSTIC - Get all questions and question data from database
app.get('/api/support-questions-diagnostic', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admin can access diagnostic endpoint'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Get count of questions
    const countQuery = `SELECT COUNT(*) as count FROM ZAIN_SUPPORT_ASKED_QUESTIONS`;
    const countResult = await connection.execute(countQuery);
    const questionCount = countResult.rows[0][0];
    
    console.log(`[${new Date().toISOString()}] DIAGNOSTIC: Total questions in database: ${questionCount}`);

    // Get all questions with all fields
    const allQuestionsQuery = `
      SELECT QUESTION_ID, TITLE, DESCRIPTION, ASKED_BY, ASKED_AT, STATUS
      FROM ZAIN_SUPPORT_ASKED_QUESTIONS
      ORDER BY QUESTION_ID DESC
    `;

    const allQuestionsResult = await connection.execute(allQuestionsQuery);
    
    console.log(`[${new Date().toISOString()}] DIAGNOSTIC: Raw question rows returned: ${allQuestionsResult.rows.length}`);
    
    const questions = allQuestionsResult.rows.map((row, index) => {
      console.log(`[${new Date().toISOString()}] DIAGNOSTIC: Row ${index} - ID: ${row[0]}, Title: ${row[1]}, Asked By: ${row[3]}`);
      return {
        rowIndex: index,
        questionId: row[0],
        questionIdType: typeof row[0],
        title: row[1],
        description: row[2],
        askedBy: row[3],
        askedAt: row[4],
        status: row[5]
      };
    });

    // Also check table structure
    const tableStructQuery = `
      SELECT COLUMN_NAME, DATA_TYPE, NULLABLE
      FROM USER_COLS
      WHERE TABLE_NAME = 'ZAIN_SUPPORT_ASKED_QUESTIONS'
      ORDER BY COLUMN_ID
    `;
    
    const tableStructResult = await connection.execute(tableStructQuery);
    
    const tableStructure = tableStructResult.rows.map(row => ({
      columnName: row[0],
      dataType: row[1],
      nullable: row[2]
    }));

    res.json({
      success: true,
      totalQuestionCount: questionCount,
      questionsRetrieved: questions.length,
      questions: questions,
      tableStructure: tableStructure
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] DIAGNOSTIC ERROR:`, err.message);
    res.status(500).json({
      success: false,
      message: 'Error retrieving diagnostic data: ' + err.message,
      errorCode: err.errorNum
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// POST - Add a reply to a question (ADMIN ONLY)
app.post('/api/support-replies', requireAuth, async (req, res) => {
  console.log(`[${new Date().toISOString()}] POST /api/support-replies - User: ${req.session.user.username}, Role: ${req.session.user.role}`);
  console.log(`[${new Date().toISOString()}] Request body:`, JSON.stringify(req.body));
  
  let { questionId, replyText } = req.body;

  // Check if user is admin
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only administrators can reply to support questions.'
    });
  }

  // Type coercion and validation
  questionId = parseInt(questionId, 10);
  replyText = String(replyText || '').trim();
  const repliedBy = String(req.session.user.username || 'unknown');

  if (!Number.isInteger(questionId) || questionId <= 0) {
    console.error(`[${new Date().toISOString()}] Invalid questionId: ${questionId}`);
    return res.status(400).json({
      success: false,
      message: 'Invalid question ID (must be a positive integer)'
    });
  }

  if (!replyText || replyText.length === 0) {
    console.error(`[${new Date().toISOString()}] Empty replyText`);
    return res.status(400).json({
      success: false,
      message: 'Reply text cannot be empty'
    });
  }

  if (replyText.length > 4000) {
    console.error(`[${new Date().toISOString()}] Reply text too long: ${replyText.length} characters`);
    return res.status(400).json({
      success: false,
      message: 'Reply text is too long (max 4000 characters)'
    });
  }

  console.log(`[${new Date().toISOString()}] Validated parameters - QID: ${questionId}, RepliedBy: ${repliedBy}, TextLength: ${replyText.length}`);

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // First, log what questions exist in the database
    const checkAllQuestionsQuery = `SELECT QUESTION_ID, TITLE FROM ZAIN_SUPPORT_ASKED_QUESTIONS ORDER BY QUESTION_ID DESC`;
    const allQuestionsResult = await connection.execute(checkAllQuestionsQuery);
    
    console.log(`[${new Date().toISOString()}] ℹ️ Total questions in database: ${allQuestionsResult.rows.length}`);
    if (allQuestionsResult.rows.length > 0) {
      allQuestionsResult.rows.forEach((row, index) => {
        console.log(`[${new Date().toISOString()}]   Question ${index + 1}: ID=${row[0]} (type: ${typeof row[0]}), Title="${row[1]}"`);
      });
    }
    
    console.log(`[${new Date().toISOString()}] Looking for QUESTION_ID = ${questionId} (type: ${typeof questionId})`);

    const insertQuery = `
      INSERT INTO SUPPORT_REPLIES (REPLY_ID, QUESTION_ID, REPLY_TEXT, REPLIED_BY)
      VALUES (SUPPORT_REPLIES_SEQ.NEXTVAL, :questionId, :replyText, :repliedBy)
    `;

    try {
      const result = await connection.execute(
        insertQuery,
        {
          questionId: questionId,
          replyText: replyText,
          repliedBy: repliedBy
        },
        { autoCommit: true }
      );

      console.log(`[${new Date().toISOString()}] ✓ Reply inserted successfully for question ${questionId}`);
      console.log(`[${new Date().toISOString()}] Rows affected: ${result.rowsAffected || 1}`);

      res.json({
        success: true,
        message: 'Reply submitted successfully'
      });
    } catch (insertErr) {
      // Detailed error handling
      const errorCode = insertErr.errorNum || 'UNKNOWN';
      const errorMsg = insertErr.message || 'Unknown error';
      
      console.error(`[${new Date().toISOString()}] ✗ Insert error - Code: ${errorCode}, Message: ${errorMsg}`);
      
      // Check for specific error codes
      if (errorCode === 2291 || errorCode === 2292) {
        // Foreign key violation - question doesn't exist
        console.error(`[${new Date().toISOString()}] ✗ FK CONSTRAINT VIOLATION: Question ${questionId} does not exist in ZAIN_SUPPORT_ASKED_QUESTIONS`);
        return res.status(404).json({
          success: false,
          message: `Question with ID ${questionId} not found or has been deleted`
        });
      } else if (errorCode === 1400) {
        // NOT NULL constraint violated
        return res.status(400).json({
          success: false,
          message: 'Missing required field (invalid session or user data)'
        });
      } else if (errorCode === 12514) {
        // Database connection error
        return res.status(503).json({
          success: false,
          message: 'Database service temporarily unavailable'
        });
      } else {
        // Generic error
        throw insertErr;
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Database error in /api/support-replies`);
    console.error(`[${new Date().toISOString()}] Error code:`, err.errorNum);
    console.error(`[${new Date().toISOString()}] Error message:`, err.message);
    console.error(`[${new Date().toISOString()}] SQL State:`, err.sqlState);
    
    let errorMsg = 'Error submitting reply: ';
    if (err.errorNum === 955) {
      errorMsg += 'Sequence SUPPORT_REPLIES_SEQ does not exist';
    } else if (err.errorNum === 942) {
      errorMsg += 'Table SUPPORT_REPLIES does not exist';
    } else if (err.errorNum === 54) {
      errorMsg += 'Resource temporarily unavailable';
    } else {
      errorMsg += `Database error (Code: ${err.errorNum || 'UNKNOWN'}): ${err.message}`;
    }
    
    res.status(500).json({
      success: false,
      message: errorMsg
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// ===================== REPORT GENERATOR ENDPOINTS =====================

// POST - Generate report preview (first 10 records of each type)
app.post('/api/generate-report', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can generate reports'
    });
  }

  const { startDate, endDate } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: 'Start date and end date are required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Query mobile numbers logs
    const numbersQuery = `
      SELECT MOBILE_NUMBER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME
      FROM ZAINSUPPORTNUMLOGS
      WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY UPDATE_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const numbersResult = await connection.execute(numbersQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query SIM logs
    const simsQuery = `
      SELECT SIM_IDENTIFIER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME
      FROM ZAIN_SUPPORT_SIMS_LOGS
      WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY UPDATE_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const simsResult = await connection.execute(simsQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query failed numbers logs
    const failedNumbersQuery = `
      SELECT MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT
      FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
      WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY CREATED_AT DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const failedNumbersResult = await connection.execute(failedNumbersQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query failed SIMs logs
    const failedSimsQuery = `
      SELECT SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT
      FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
      WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY CREATED_AT DESC
      FETCH FIRST 10 ROWS ONLY
    `;
    const failedSimsResult = await connection.execute(failedSimsQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Convert rows to objects
    const convertRowsToObjects = (rows, columns) => {
      return rows.map(row => {
        const obj = {};
        columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      });
    };

    const numbers = convertRowsToObjects(numbersResult.rows, ['MOBILE_NUMBER', 'STATUS_BEFORE', 'STATUS_AFTER', 'USERNAME', 'UPDATE_TIME']);
    const sims = convertRowsToObjects(simsResult.rows, ['SIM_IDENTIFIER', 'STATUS_BEFORE', 'STATUS_AFTER', 'USERNAME', 'UPDATE_TIME']);
    const failedNumbers = convertRowsToObjects(failedNumbersResult.rows, ['MOBILE_NUMBER', 'FAILURE_REASON', 'USERNAME', 'CREATED_AT']);
    const failedSims = convertRowsToObjects(failedSimsResult.rows, ['SIM_IDENTIFIER', 'FAILURE_REASON', 'USERNAME', 'CREATED_AT']);

    res.json({
      success: true,
      numbers,
      sims,
      failedNumbers,
      failedSims
    });

  } catch (err) {
    console.error('Error generating report:', err);
    res.status(500).json({
      success: false,
      message: 'Error generating report: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// GET - Download full report as Excel
app.get('/api/download-report', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Only admins can download reports'
    });
  }

  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: 'Start date and end date are required'
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    // Query all mobile numbers logs for the date range
    const numbersQuery = `
      SELECT MOBILE_NUMBER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME
      FROM ZAINSUPPORTNUMLOGS
      WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY UPDATE_TIME DESC
    `;
    const numbersResult = await connection.execute(numbersQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query all SIM logs for the date range
    const simsQuery = `
      SELECT SIM_IDENTIFIER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME
      FROM ZAIN_SUPPORT_SIMS_LOGS
      WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY UPDATE_TIME DESC
    `;
    const simsResult = await connection.execute(simsQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query all failed numbers logs for the date range
    const failedNumbersQuery = `
      SELECT MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT
      FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
      WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY CREATED_AT DESC
    `;
    const failedNumbersResult = await connection.execute(failedNumbersQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Query all failed SIMs logs for the date range
    const failedSimsQuery = `
      SELECT SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT
      FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
      WHERE CREATED_AT >= TO_DATE(:startDate, 'YYYY-MM-DD')
        AND CREATED_AT < TO_DATE(:endDate, 'YYYY-MM-DD') + 1
      ORDER BY CREATED_AT DESC
    `;
    const failedSimsResult = await connection.execute(failedSimsQuery, { 
      startDate: startDate, 
      endDate: endDate 
    });

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();

    // Add sheets and data
    if (numbersResult.rows.length > 0) {
      const ws1 = workbook.addWorksheet('Mobile Numbers');
      ws1.columns = [
        { header: 'Mobile Number', key: 'MOBILE_NUMBER', width: 15 },
        { header: 'Status Before', key: 'STATUS_BEFORE', width: 15 },
        { header: 'Status After', key: 'STATUS_AFTER', width: 15 },
        { header: 'Updated By', key: 'USERNAME', width: 15 },
        { header: 'Update Time', key: 'UPDATE_TIME', width: 20 }
      ];
      numbersResult.rows.forEach(row => {
        ws1.addRow({
          MOBILE_NUMBER: row[0],
          STATUS_BEFORE: row[1],
          STATUS_AFTER: row[2],
          USERNAME: row[3],
          UPDATE_TIME: row[4]
        });
      });
      ws1.views = [{ state: 'frozen', ySplit: 1 }];
    }

    if (simsResult.rows.length > 0) {
      const ws2 = workbook.addWorksheet('SIM Cards');
      ws2.columns = [
        { header: 'SIM Identifier', key: 'SIM_IDENTIFIER', width: 15 },
        { header: 'Status Before', key: 'STATUS_BEFORE', width: 15 },
        { header: 'Status After', key: 'STATUS_AFTER', width: 15 },
        { header: 'Updated By', key: 'USERNAME', width: 15 },
        { header: 'Update Time', key: 'UPDATE_TIME', width: 20 }
      ];
      simsResult.rows.forEach(row => {
        ws2.addRow({
          SIM_IDENTIFIER: row[0],
          STATUS_BEFORE: row[1],
          STATUS_AFTER: row[2],
          USERNAME: row[3],
          UPDATE_TIME: row[4]
        });
      });
      ws2.views = [{ state: 'frozen', ySplit: 1 }];
    }

    if (failedNumbersResult.rows.length > 0) {
      const ws3 = workbook.addWorksheet('Failed Numbers');
      ws3.columns = [
        { header: 'Mobile Number', key: 'MOBILE_NUMBER', width: 15 },
        { header: 'Failure Reason', key: 'FAILURE_REASON', width: 30 },
        { header: 'Username', key: 'USERNAME', width: 15 },
        { header: 'Created At', key: 'CREATED_AT', width: 20 }
      ];
      failedNumbersResult.rows.forEach(row => {
        ws3.addRow({
          MOBILE_NUMBER: row[0],
          FAILURE_REASON: row[1],
          USERNAME: row[2],
          CREATED_AT: row[3]
        });
      });
      ws3.views = [{ state: 'frozen', ySplit: 1 }];
    }

    if (failedSimsResult.rows.length > 0) {
      const ws4 = workbook.addWorksheet('Failed SIMs');
      ws4.columns = [
        { header: 'SIM Identifier', key: 'SIM_IDENTIFIER', width: 15 },
        { header: 'Failure Reason', key: 'FAILURE_REASON', width: 30 },
        { header: 'Username', key: 'USERNAME', width: 15 },
        { header: 'Created At', key: 'CREATED_AT', width: 20 }
      ];
      failedSimsResult.rows.forEach(row => {
        ws4.addRow({
          SIM_IDENTIFIER: row[0],
          FAILURE_REASON: row[1],
          USERNAME: row[2],
          CREATED_AT: row[3]
        });
      });
      ws4.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // Set response headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Report_${startDate}_to_${endDate}.xlsx"`);

    // Send the workbook
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Error downloading report:', err);
    res.status(500).json({
      success: false,
      message: 'Error downloading report: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// Start the server
app.listen(PORT, async () => {
  await initializePool();
  await testEmailConfig();
  console.log(`Server is running on http://localhost:${PORT}`);
  
  // Start the daily summary reporter
  setTimeout(() => {
    startSummaryReporter();
  }, 1000); // Wait 1 second for pool to fully initialize

  // Start the failed updates reporter
  setTimeout(() => {
    startFailedUpdatesReporter();
  }, 1500); // Wait 1.5 seconds for pool to fully initialize
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (connectionPool) {
    try {
      await connectionPool.close();
      console.log('Connection pool closed');
    } catch (err) {
      console.error('Error closing pool:', err);
    }
  }
  process.exit(0);
});
