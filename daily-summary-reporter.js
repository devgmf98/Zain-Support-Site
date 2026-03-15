const oracledb = require('oracledb');
const nodemailer = require('nodemailer');
require('dotenv').config();

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


const cron = require('node-cron');
// Initialize Oracle connection pool
let connectionPool;

/**
 * Initialize Oracle connection pool
 */
async function initializePool() {
  try {
    console.log(`[${new Date().toISOString()}] Initializing Oracle connection pool...`);
    connectionPool = await oracledb.createPool({
      user: dbConfig.user,
      password: dbConfig.password,
      connectString: dbConfig.connectString,
      poolMax: 10,
      poolMin: 2,
      getConnectionTimeout: 120
    });
    console.log(`[${new Date().toISOString()}] ✓ Oracle connection pool initialized successfully`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to initialize Oracle connection pool:`, err.message);
    process.exit(1);
  }
}

/**
 * Get summary data for today
 */
async function getSummaryData() {
  let connection;
  const summary = {
    numbers: {},
    sims: {},
    timestamp: new Date().toISOString()
  };

  try {
    connection = await connectionPool.getConnection();

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

    return summary;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Error retrieving summary data:`, err.message);
    return null;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error(`[${new Date().toISOString()}] Error closing connection:`, closeErr);
      }
    }
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
 * Get recipient emails from database
 */
async function getRecipientEmails() {
  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT EMAIL FROM RECIPIENT_EMAILS WHERE ROWNUM >= 1 ORDER BY EMAIL`;
    const result = await connection.execute(query);

    return result.rows.map(row => row[0]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching recipient emails:`, err.message);
    return [];
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error(`[${new Date().toISOString()}] Error closing connection:`, closeErr);
      }
    }
  }
}

/**
 * Send summary email
 */
async function sendSummaryEmail(summary) {
  try {
    const recipients = await getRecipientEmails();

    if (recipients.length === 0) {
      console.warn(`[${new Date().toISOString()}] ⚠️  No recipient emails configured. Skipping email notification.`);
      console.warn(`[${new Date().toISOString()}] Please add recipient emails in Settings > Email Recipients`);
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
      from: 'devgmf98@gmail.com',
      to: recipients.join(','),
      subject: `Daily Summary: Status Updates - ${new Date().toLocaleDateString()}`,
      html: htmlContent
    };

    console.log(`[${new Date().toISOString()}] Sending summary email to ${recipients.length} recipient(s): ${recipients.join(', ')}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[${new Date().toISOString()}] ✓ Summary email sent successfully`);
    console.log(`[${new Date().toISOString()}] Response:`, info.response);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to send summary email:`, err.message);
    return false;
  }
}

/**
 * Run the reporter
 */
async function runReporter() {
  console.log(`[${new Date().toISOString()}] Starting daily summary report...`);
  const summary = await getSummaryData();
  
  if (summary) {
    await sendSummaryEmail(summary);
  }
  
  console.log(`[${new Date().toISOString()}] Daily summary report completed.`);
}

/**
 * Schedule reporter to run every 5 minutes
 */
function scheduleReporter() {
  console.log(`[${new Date().toISOString()}] Scheduling daily summary reporter to run every day at 10:00 PM...`);

  // Schedule to run at 10:00 PM every day
  cron.schedule('0 22 * * *', () => {
    runReporter();
  }, {
    timezone: 'Asia/Riyadh' // Set to your local timezone if needed
  });
}

/**
 * Initialize and start the reporter
 */
async function start() {
  try {
    console.log(`[${new Date().toISOString()}] ========================================`);
    console.log(`[${new Date().toISOString()}] Daily Summary Reporter Service Starting`);
    console.log(`[${new Date().toISOString()}] ========================================`);

    await initializePool();
    scheduleReporter();

    console.log(`[${new Date().toISOString()}] ✓ Daily Summary Reporter Service is running`);
    console.log(`[${new Date().toISOString()}] Reports will be sent every day at 10:00 PM`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ✗ Failed to start Daily Summary Reporter:`, err.message);
    process.exit(1);
  }
}

// Start the service
start();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down Daily Summary Reporter...`);
  if (connectionPool) {
    try {
      await connectionPool.close();
      console.log(`[${new Date().toISOString()}] ✓ Connection pool closed`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error closing pool:`, err);
    }
  }
  process.exit(0);
});

module.exports = { scheduleReporter, getSummaryData, sendSummaryEmail };
