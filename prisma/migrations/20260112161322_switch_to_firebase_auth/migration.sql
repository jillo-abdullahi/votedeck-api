/*
  Warnings:

  - You are about to drop the column `recovery_code` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `recovery_hash` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "users_recovery_code_key";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "recovery_code",
DROP COLUMN "recovery_hash",
ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "email" TEXT,
ALTER COLUMN "name" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
