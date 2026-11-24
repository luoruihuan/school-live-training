CREATE TABLE IF NOT EXISTS `CssStream` (
  `id` VARCHAR(32) NOT NULL,
  `roomId` VARCHAR(191) NOT NULL,
  `routeVersion` VARCHAR(32) NOT NULL,
  `activeSequence` VARCHAR(64) NULL,
  `lastStatusAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `CssStream_roomId_routeVersion_key` (`roomId`, `routeVersion`),
  CONSTRAINT `CssStream_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `Room` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `CssPushEvent` (
  `streamId` VARCHAR(32) NOT NULL,
  `sequence` VARCHAR(64) NOT NULL,
  `eventType` TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (`streamId`, `sequence`, `eventType`),
  CONSTRAINT `CssPushEvent_streamId_fkey` FOREIGN KEY (`streamId`) REFERENCES `CssStream` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
