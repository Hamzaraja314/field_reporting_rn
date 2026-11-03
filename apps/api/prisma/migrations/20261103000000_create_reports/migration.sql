CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportImage" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "storageKey" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "orderIndex" INTEGER NOT NULL,

    CONSTRAINT "ReportImage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReportImage_sizeBytes_check" CHECK ("sizeBytes" > 0),
    CONSTRAINT "ReportImage_orderIndex_check" CHECK ("orderIndex" BETWEEN 0 AND 4)
);

CREATE UNIQUE INDEX "Report_idempotencyKey_key" ON "Report"("idempotencyKey");
CREATE INDEX "Report_createdAt_id_idx" ON "Report"("createdAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "ReportImage_storageKey_key" ON "ReportImage"("storageKey");
CREATE UNIQUE INDEX "ReportImage_reportId_orderIndex_key" ON "ReportImage"("reportId", "orderIndex");
CREATE INDEX "ReportImage_reportId_idx" ON "ReportImage"("reportId");

ALTER TABLE "ReportImage"
    ADD CONSTRAINT "ReportImage_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "Report"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
