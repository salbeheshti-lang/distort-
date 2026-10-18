-- CreateTable
CREATE TABLE "VpnServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "flag" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocols" TEXT NOT NULL,
    "load" INTEGER NOT NULL DEFAULT 0,
    "ping" INTEGER NOT NULL DEFAULT 0,
    "upMbps" INTEGER NOT NULL DEFAULT 1000,
    "downMbps" INTEGER NOT NULL DEFAULT 1000,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "premium" BOOLEAN NOT NULL DEFAULT false,
    "stealth" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'wireguard',
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "bytesDown" INTEGER NOT NULL DEFAULT 0,
    "bytesUp" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "VpnServer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VpnConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'distort',
    "country" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CommunityConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "protocol" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "country" TEXT,
    "note" TEXT,
    "reach" TEXT NOT NULL DEFAULT 'unknown',
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMin" INTEGER NOT NULL DEFAULT 60,
    "lastFetchedAt" DATETIME,
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ImportedConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT,
    "protocol" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "label" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'tcp',
    "security" TEXT NOT NULL DEFAULT 'none',
    "sni" TEXT,
    "path" TEXT,
    "hostHeader" TEXT,
    "flow" TEXT,
    "country" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "flags" TEXT NOT NULL DEFAULT '',
    "reach" TEXT NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "bucket" TEXT NOT NULL DEFAULT 'all',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportedConfig_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "protocol" TEXT NOT NULL DEFAULT 'wireguard',
    "killSwitch" BOOLEAN NOT NULL DEFAULT true,
    "dnsLeakProtection" BOOLEAN NOT NULL DEFAULT true,
    "ipv6LeakProtection" BOOLEAN NOT NULL DEFAULT true,
    "splitTunneling" BOOLEAN NOT NULL DEFAULT false,
    "obfuscation" BOOLEAN NOT NULL DEFAULT true,
    "autoConnect" BOOLEAN NOT NULL DEFAULT false,
    "blockTrackers" BOOLEAN NOT NULL DEFAULT true,
    "blockAds" BOOLEAN NOT NULL DEFAULT false,
    "stealthMode" BOOLEAN NOT NULL DEFAULT true,
    "preferredRegion" TEXT NOT NULL DEFAULT 'auto',
    "mtu" INTEGER NOT NULL DEFAULT 1420,
    "dnsServers" TEXT NOT NULL DEFAULT '1.1.1.1,9.9.9.9',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "vipUntil" DATETIME,
    "referral" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "passwordHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AdminMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL DEFAULT 'support',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reply" TEXT,
    "repliedAt" DATETIME,
    "handledBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProbeResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT,
    "planId" TEXT,
    "structural" TEXT NOT NULL,
    "reachability" TEXT NOT NULL DEFAULT 'not-probed',
    "tunnel" TEXT NOT NULL DEFAULT 'not-attempted',
    "latencyMs" INTEGER,
    "exitIp" TEXT,
    "exitCountry" TEXT,
    "failureReason" TEXT,
    "probedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "candidateLabel" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "latencyMs" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "VpnServer_code_key" ON "VpnServer"("code");

-- CreateIndex
CREATE INDEX "ImportedConfig_subscriptionId_idx" ON "ImportedConfig"("subscriptionId");

-- CreateIndex
CREATE INDEX "ImportedConfig_bucket_idx" ON "ImportedConfig"("bucket");

-- CreateIndex
CREATE INDEX "ImportedConfig_favorite_idx" ON "ImportedConfig"("favorite");

-- CreateIndex
CREATE INDEX "ImportedConfig_score_idx" ON "ImportedConfig"("score");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ProbeResult_configId_idx" ON "ProbeResult"("configId");

-- CreateIndex
CREATE INDEX "ProbeResult_planId_idx" ON "ProbeResult"("planId");

-- CreateIndex
CREATE INDEX "ProbeResult_probedAt_idx" ON "ProbeResult"("probedAt");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_planId_idx" ON "RecoveryAttempt"("planId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_startedAt_idx" ON "RecoveryAttempt"("startedAt");

