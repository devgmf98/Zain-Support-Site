# Zain Support API Documentation

## Base URL
```
http://localhost:3000
```

## Authentication
Most endpoints require user authentication via session. Users must login first to access protected endpoints.

---

## Authentication Endpoints

### 1. Login
**POST** `/api/login`

Login user with credentials and create a session.

**Request Body:**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "username": "admin",
    "role": "admin"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Invalid username or password"
}
```

**Status Codes:** 200, 401, 500

---

### 2. Logout
**POST** `/api/logout`

Logout current user and destroy session.

**Response (Success):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Status Codes:** 200, 500

---

### 3. Get Current User
**GET** `/api/current-user`

Get information about currently logged-in user.

**Response (Success):**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "No user logged in"
}
```

**Status Codes:** 200, 401

---

## User Management Endpoints

### 4. Create User
**POST** `/api/create-user`

Create a new user. **Admin only**.

**Request Body:**
```json
{
  "username": "john_staff",
  "password": "password123",
  "role": "staff"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "User 'john_staff' created successfully with role 'staff'"
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Username already exists"
}
```

**Validation Rules:**
- Username is required
- Password must be at least 6 characters
- Role must be either "admin" or "staff"
- Username must be unique

**Status Codes:** 200, 400, 403, 500

---

### 5. Get All Users
**GET** `/api/users`

Get list of all users. **Admin only**.

**Response (Success):**
```json
{
  "success": true,
  "users": [
    {
      "userId": 1,
      "username": "admin",
      "role": "admin",
      "active": true,
      "createdAt": "2026-03-10T12:05:08.276Z"
    },
    {
      "userId": 2,
      "username": "staff",
      "role": "staff",
      "active": true,
      "createdAt": "2026-03-10T12:05:08.274Z"
    }
  ]
}
```

**Status Codes:** 200, 403, 500

---

### 6. Toggle User Status
**POST** `/api/toggle-user`

Enable or disable a user account. **Admin only**.

**Request Body:**
```json
{
  "userId": 2,
  "active": false
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "User disabled successfully"
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "User not found"
}
```

**Status Codes:** 200, 404, 403, 500

---

### 7. Change Password
**POST** `/api/change-password`

Change password for current user.

**Request Body:**
```json
{
  "currentPassword": "admin123",
  "newPassword": "newPassword456"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Current password is incorrect"
}
```

**Validation Rules:**
- Current password must be correct
- New password must be at least 6 characters

**Status Codes:** 200, 401, 404, 500

---

## Database Status Endpoints

### 8. Health Check
**GET** `/api/health`

Check database connection status. **Requires authentication**.

**Response (Success):**
```json
{
  "status": "connected",
  "database": "172.168.101.103:1521/ZSSUAT",
  "user": "CBS_DB_OPSUPP",
  "message": "Database connection successful",
  "timestamp": "2026-03-10T12:23:05.509Z"
}
```

**Response (Error):**
```json
{
  "status": "error",
  "message": "Database connection failed: ...",
  "database": "172.168.101.103:1521/ZSSUAT",
  "user": "CBS_DB_OPSUPP",
  "errorCode": "...",
  "suggestions": [
    "1. Verify the database host is reachable",
    "2. Check if port 1521 is open",
    "..."
  ]
}
```

**Status Codes:** 200, 503

---

## Mobile Status Update Endpoints

### 9. Update Single Mobile Number Status
**POST** `/api/update-status`

Update status for a single mobile number. **Requires authentication**.

**Request Body:**
```json
{
  "mobileNumber": "3001234567",
  "statusValue": "A"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Status updated successfully for mobile number: 3001234567",
  "rowsUpdated": 1
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Current status can't be updated. Mobile number 3001234567 is restricted (status: A)"
}
```

**Restrictions:**
- Cannot update numbers with status A, Z, or N
- Cannot update restricted numbers (9123, 9121, 9122)

**Status Codes:** 200, 400, 404, 500

**Logging:**
- Update is logged in `ZAINSUPPORTNUMLOGS` table with:
  - Mobile number
  - Status before
  - Status after
  - Username
  - Timestamp

---

### 10. Bulk Update Mobile Numbers
**POST** `/api/bulk-update-status`

Update status for multiple mobile numbers at once. **Requires authentication**.

**Request Body:**
```json
{
  "mobileNumbers": ["3001234567", "3009876543"],
  "statusValue": "B"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Updated: 2, Restricted: 0, Failed: 0",
  "summary": {
    "total": 2,
    "updated": 2,
    "restricted": 0,
    "failed": 0
  }
}
```

**Response (Error):**
```json
{
  "success": true,
  "message": "Updated: 1, Restricted: 1, Failed: 0",
  "summary": {
    "total": 2,
    "updated": 1,
    "restricted": 1,
    "failed": 0
  }
}
```

**Status Codes:** 200, 400, 500

**Logging:**
- Each successful update is logged in `ZAINSUPPORTNUMLOGS` table

**Email Notification:**
- Email sent to BSS_OPS@ss.zain.com with update summary

---

## SIM Status Update Endpoints

### 11. Update SIM by Identifier
**POST** `/api/update-sims-status`

Update status for SIMs by identifier. **Requires authentication**.

**Request Body:**
```json
{
  "simIdentifier": "12345 67890",
  "statusValue": "B"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Updated 2 SIM(s) successfully | Status updated to B",
  "summary": {
    "total": 2,
    "updated": 2,
    "restricted": 0,
    "failed": 0
  }
}
```

**Status Codes:** 200, 400, 500

**Input Format:**
- Comma or space separated SIM identifiers
- Example: "12345, 67890" or "12345 67890"

**Logging:**
- Each update logged in `ZAIN_SUPPORT_SIMS_LOGS` table

**Email Notification:**
- Email sent to BSS_OPS@ss.zain.com with update details

---

### 12. Update SIM by Number
**POST** `/api/update-sim-num-status`

Update status for SIMs by SIM number. **Requires authentication**.

**Request Body:**
```json
{
  "simNum": "89216543210123456789 89216543210123456790",
  "statusValue": "B"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Updated 2 SIM number(s) successfully | Status updated to B",
  "summary": {
    "total": 2,
    "updated": 2,
    "restricted": 0,
    "failed": 0
  }
}
```

**Status Codes:** 200, 400, 500

**Input Format:**
- Comma or space separated SIM numbers
- Example: "89216543210123456789, 89216543210123456790"

**Logging:**
- Each update logged in `ZAIN_SUPPORT_SIMS_LOGS` table

**Email Notification:**
- Email sent to BSS_OPS@ss.zain.com with update details

---

## Mobile Details Endpoints

### 13. Get Mobile Number Details
**GET** `/api/get-mobile-details/:mobileNumber`

Get details for a specific mobile number. **Requires authentication**.

**URL Parameter:**
- `mobileNumber` - The mobile number to query

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "mobileNumber": "3001234567",
    "categoryCode": "POSTPAID",
    "status": "B"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "No record found for mobile number: 3001234567"
}
```

**Status Codes:** 200, 404, 500

---

### 14. Get Mobile Status
**GET** `/api/get-status/:mobileNumber`

Get only the status for a mobile number. **Requires authentication**.

**URL Parameter:**
- `mobileNumber` - The mobile number to query

**Response (Success):**
```json
{
  "success": true,
  "data": {
    "mobileNumber": "3001234567",
    "status": "B"
  }
}
```

**Status Codes:** 200, 404, 500

---

## Email Test Endpoint

### 15. Test Email Configuration
**GET** `/api/test-email`

Test email configuration without authentication.

**Response (Success):**
```json
{
  "status": "success",
  "message": "Email configuration is valid",
  "emailConfig": {
    "service": "Gmail",
    "user": "gabrielgmf98@gmail.com",
    "from": "gabrielgmf98@gmail.com"
  }
}
```

**Response (Error):**
```json
{
  "status": "error",
  "message": "Email configuration error: ...",
  "suggestions": [
    "1. Verify EMAIL_USER and EMAIL_PASSWORD in .env file",
    "..."
  ],
  "emailConfig": {
    "service": "Gmail",
    "user": "gabrielgmf98@gmail.com"
  }
}
```

**Status Codes:** 200, 503

---

## Database Tables

### ZAINSUPPORTUSERS
Stores user account information:
- `USER_ID` - Primary key
- `USERNAME` - Unique username
- `PASSWORD` - Bcrypt hashed password
- `ROLE` - "admin" or "staff"
- `ACTIVE` - 1 (active) or 0 (inactive)
- `CREATED_AT` - Account creation timestamp

### ZAINSUPPORTNUMLOGS
Logs mobile number status updates:
- `LOG_ID` - Primary key
- `MOBILE_NUMBER` - Updated phone number
- `STATUS_BEFORE` - Previous status
- `STATUS_AFTER` - New status
- `USERNAME` - User who made the update
- `UPDATE_TIME` - When the update occurred
- `CREATED_AT` - Timestamp

### ZAIN_SUPPORT_SIMS_LOGS
Logs SIM status updates:
- `LOG_ID` - Primary key
- `SIM_IDENTIFIER` - Updated SIM identifier
- `STATUS_BEFORE` - Previous status
- `STATUS_AFTER` - New status
- `USERNAME` - User who made the update
- `UPDATE_TIME` - When the update occurred
- `CREATED_AT` - Timestamp

---

## Error Handling

All endpoints return standard error responses:

**400 Bad Request:**
```json
{
  "success": false,
  "message": "Descriptive error message"
}
```

**401 Unauthorized:**
```json
{
  "success": false,
  "message": "Unauthorized. Please login."
}
```

**403 Forbidden:**
```json
{
  "success": false,
  "message": "Only admins can perform this action"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "message": "Database error: ..."
}
```

---

## Default Users

After initial setup, two users are automatically created:

| Username | Password | Role |
|----------|----------|------|
| admin | admin123 | admin |
| staff | staff123 | staff |

---

## Session Configuration

- Session timeout: 24 hours
- Secure cookies: HttpOnly (disabled if not using HTTPS)
- Session secret: Stored in environment variable `SESSION_SECRET`

---

## Example Usage

### 1. Login
```bash
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### 2. Create User
```bash
curl -X POST http://localhost:3000/api/create-user \
  -H "Content-Type: application/json" \
  -d '{"username":"newuser","password":"pass123","role":"staff"}' \
  -b "cookies.txt" -c "cookies.txt"
```

### 3. Update Mobile Status
```bash
curl -X POST http://localhost:3000/api/update-status \
  -H "Content-Type: application/json" \
  -d '{"mobileNumber":"3001234567","statusValue":"B"}' \
  -b "cookies.txt" -c "cookies.txt"
```

### 4. Bulk Update
```bash
curl -X POST http://localhost:3000/api/bulk-update-status \
  -H "Content-Type: application/json" \
  -d '{
    "mobileNumbers":["3001234567","3009876543"],
    "statusValue":"B"
  }' \
  -b "cookies.txt" -c "cookies.txt"
```

---

## Version
API Version: 1.0.0
Last Updated: March 10, 2026
