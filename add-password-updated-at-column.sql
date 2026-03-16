-- Script to add PASSWORD_UPDATED_AT column to ZAINSUPPORTUSERS table
-- Purpose: Track when user passwords are changed or reset
-- Database: Oracle 11g/12c
-- User: CBS_DB_OPSUPP
-- Connection: 172.168.101.238:1521/PDB1

-- Add PASSWORD_UPDATED_AT column to track password changes
ALTER TABLE ZAINSUPPORTUSERS ADD (
    PASSWORD_UPDATED_AT TIMESTAMP
);

-- Update existing records to set PASSWORD_UPDATED_AT to their CREATED_AT value
UPDATE ZAINSUPPORTUSERS 
SET PASSWORD_UPDATED_AT = CREATED_AT;

-- Verify the column was added and populated successfully
DESC ZAINSUPPORTUSERS;

-- Query to check the new column
SELECT USER_ID, USERNAME, ROLE, CREATED_AT, PASSWORD_UPDATED_AT 
FROM ZAINSUPPORTUSERS;

-- Commit the changes
COMMIT;
