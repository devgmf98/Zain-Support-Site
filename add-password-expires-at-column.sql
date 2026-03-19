-- Script to add PASSWORD_EXPIRES_AT column to ZAINSUPPORTUSERS table
-- Purpose: Track when user passwords expire (90 days for non-admin users)
-- Database: Oracle 11g/12c
-- User: CBS_DB_OPSUPP
-- Connection: 172.168.101.238:1521/PDB1

-- Add PASSWORD_EXPIRES_AT column to track password expiration
ALTER TABLE ZAINSUPPORTUSERS ADD (
    PASSWORD_EXPIRES_AT TIMESTAMP
);

-- Update existing records:
-- For admin users: set PASSWORD_EXPIRES_AT to NULL (never expires)
-- For non-admin users: set PASSWORD_EXPIRES_AT to 90 days from their CREATED_AT
UPDATE ZAINSUPPORTUSERS 
SET PASSWORD_EXPIRES_AT = CASE 
    WHEN ROLE = 'admin' THEN NULL
    ELSE CREATED_AT + 90
END;

-- Verify the column was added and populated successfully
DESC ZAINSUPPORTUSERS;

-- Query to check the new column
SELECT USER_ID, USERNAME, ROLE, CREATED_AT, PASSWORD_EXPIRES_AT 
FROM ZAINSUPPORTUSERS;

-- Commit the changes
COMMIT;
