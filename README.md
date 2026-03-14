# G-TECH COMPANY - Customer Life Cycle Updater

A professional web application for managing customer lifecycle status updates in the Oracle `CBS_CORE.GSM_MOBILE_MASTER` table.

## Features

- Clean and intuitive user interface
- Single mobile number update
- Bulk update (space or comma separated numbers)
- Real-time status updates to Oracle database
- Input validation and error handling
- Responsive design that works on desktop and mobile
- Loading indicators for better UX
- Toast notifications for success/error feedback
- Status validation (prevents updates when current status is A, Z, or N)

## Prerequisites

- **Node.js** (v14 or higher) - Download from https://nodejs.org/
- **Oracle Instant Client** (for oracledb driver to work)
- Access to Oracle database: `172.168.101.238:1521/PDB1`

## Installation & Setup

### Step 1: Install Node.js
Download and install Node.js from https://nodejs.org/ (LTS version recommended)

### Step 2: Install Oracle Instant Client

The `oracledb` package requires Oracle Instant Client. Follow the installation guide for your OS:

**For Windows:**
1. Download Oracle Instant Client from: https://www.oracle.com/database/technologies/instant-client/downloads.html
2. Extract it to a location (e.g., `C:\oracle\instantclient_23_3`)
3. Add the folder to your PATH environment variable:
   - Right-click "This PC" → Properties → Advanced system settings → Environment Variables
   - Under "System variables", click "New"
   - Variable name: `PATH`
   - Add the Instant Client path to the existing PATH
4. Restart your terminal/command prompt

### Step 3: Install Dependencies

Navigate to the project directory and install required packages:

```bash
cd oracle-status-updater
npm install
```

This will install:
- `express` - Web server framework
- `oracledb` - Oracle database driver
- `dotenv` - Environment variable management
- `cors` - Cross-Origin Resource Sharing

### Step 4: Configure Database Connection

The `.env` file already contains your database credentials:

```
DB_USER=CBS_DB_OPSUPP
DB_PASSWORD=CBS_DB_OPSUPP
DB_HOST=172.168.101.238
DB_PORT=1521
DB_SERVICE=PDB1
PORT=3000
```

If you need to change any settings, edit the `.env` file.

### Step 5: Run the Application

Start the server:

```bash
npm start
```

You should see:
```
Oracle Connection Pool Created Successfully
Server is running on http://localhost:3000
```

### Step 6: Access the Application

Open your web browser and go to:
```
http://localhost:3000
```

## Usage

1. **Enter Mobile Number**: Input the mobile number you want to update
2. **Enter Status Value**: Enter the new status value for the STATUS_V field
3. **Click Update Status**: The application will update the database and show a confirmation message
4. **Clear**: Click the Clear button to reset the form

## Application Structure

```
oracle-status-updater/
├── server.js           # Express server and API endpoints
├── package.json        # Project dependencies
├── .env               # Database configuration (keep this secure!)
├── public/
│   └── index.html     # Frontend UI
└── README.md          # This file
```

## API Endpoints

### POST /api/update-status
Updates the STATUS_V field for a given mobile number.

**Request:**
```json
{
  "mobileNumber": "1234567890",
  "statusValue": "ACTIVE"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Status updated successfully for mobile number: 1234567890",
  "rowsUpdated": 1
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "No record found for mobile number: 1234567890"
}
```

### GET /api/get-status/:mobileNumber
Retrieves the current status for a mobile number (optional feature).

**Response:**
```json
{
  "success": true,
  "data": {
    "mobileNumber": "1234567890",
    "status": "ACTIVE"
  }
}
```

## Troubleshooting

### Issue: "Cannot find module 'oracledb'"
**Solution:** Make sure Oracle Instant Client is installed and in your PATH. Reinstall dependencies:
```bash
npm install
```

### Issue: "Connection refused" or "Network error"
**Solution:** 
- Check if the database hostname and port are correct
- Verify network connectivity to `172.168.101.238:1521`
- Ensure the database credentials are correct

### Issue: "TNS:listener does not currently know of service requested"
**Solution:** 
- Verify the service name is correct (should be `PDB1`)
- Check database connectivity from your machine

### Issue: Port 3000 already in use
**Solution:** Either close the application using port 3000 or change the port in `.env`:
```
PORT=3001
```

## Security Notes

⚠️ **Important:**
- The `.env` file contains database credentials - **DO NOT commit it to version control**
- Consider using environment variables instead of `.env` file in production
- Validate all user inputs server-side (already implemented)
- Use HTTPS in production environments
- Implement authentication and authorization for production use

## Stopping the Application

Press `Ctrl + C` in your terminal to stop the server.

## Support

If you encounter any issues:
1. Check the console/terminal for error messages
2. Verify database connectivity
3. Ensure all dependencies are installed
4. Check the `.env` file configuration

---

**Created:** January 2026
**Application:** Oracle STATUS_V Updater
