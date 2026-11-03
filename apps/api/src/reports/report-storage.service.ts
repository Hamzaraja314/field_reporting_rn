import {
  Injectable,
  Logger,
  OnModuleInit,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { PrismaService } from "../prisma/prisma.service";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StagedImage {
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

@Injectable()
export class ReportStorageService implements OnModuleInit {
  private readonly logger = new Logger(ReportStorageService.name);
  private readonly root = path.resolve(
    process.env.UPLOAD_ROOT ?? path.join(process.cwd(), "data", "uploads")
  );
  readonly tempRoot = path.join(this.root, "tmp");
  readonly finalizedRoot = path.join(this.root, "finalized");

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.tempRoot, { recursive: true });
    await fs.mkdir(this.finalizedRoot, { recursive: true });
    await this.removeExpiredTemporaryDirectories();
    await this.removeExpiredOrphanedFiles();
  }

  async createRequestDirectory(): Promise<string> {
    const directory = path.join(this.tempRoot, randomUUID());
    await fs.mkdir(directory, { recursive: false });
    return directory;
  }

  async removeRequestDirectory(directory: string): Promise<void> {
    await fs.rm(directory, { recursive: true, force: true });
  }

  async inspect(file: Express.Multer.File): Promise<StagedImage> {
    if (file.size === 0) {
      throw new UnsupportedMediaTypeException("Image files must not be empty.");
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new UnsupportedMediaTypeException("Images must not exceed 5 MiB.");
    }

    const mimeType = await this.detectMimeType(file.path, file.size);
    if (!mimeType) {
      throw new UnsupportedMediaTypeException(
        "Only valid JPEG, PNG, and WebP images are supported."
      );
    }

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk);
    }

    return {
      path: file.path,
      mimeType,
      sizeBytes: file.size,
      sha256: hash.digest("hex"),
    };
  }

  async finalize(image: StagedImage): Promise<string> {
    const extensions: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const storageKey = `finalized/${randomUUID()}.${
      extensions[image.mimeType]
    }`;
    await fs.rename(image.path, this.resolveStorageKey(storageKey));
    return storageKey;
  }

  async removeFinalized(storageKeys: string[]): Promise<void> {
    await Promise.all(
      storageKeys.map((key) =>
        fs.rm(this.resolveStorageKey(key), { force: true })
      )
    );
  }

  resolveStorageKey(storageKey: string): string {
    const resolved = path.resolve(this.root, storageKey);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Invalid image storage key.");
    }
    return resolved;
  }

  private async detectMimeType(
    filePath: string,
    fileSize: number
  ): Promise<string | null> {
    const handle = await fs.open(filePath, "r");
    try {
      const signature = Buffer.alloc(24);
      const { bytesRead } = await handle.read(
        signature,
        0,
        signature.length,
        0
      );
      const bytes = signature.subarray(0, bytesRead);

      if (
        fileSize >= 45 &&
        bytes.length >= 24 &&
        bytes
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          ) &&
        bytes.toString("ascii", 12, 16) === "IHDR" &&
        bytes.readUInt32BE(16) > 0 &&
        bytes.readUInt32BE(20) > 0
      ) {
        const tail = Buffer.alloc(12);
        const tailRead = await handle.read(
          tail,
          0,
          tail.length,
          fileSize - tail.length
        );
        if (
          tailRead.bytesRead === tail.length &&
          tail.readUInt32BE(0) === 0 &&
          tail.toString("ascii", 4, 8) === "IEND"
        ) {
          return "image/png";
        }
      }
      if (
        fileSize >= 4 &&
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      ) {
        const end = Buffer.alloc(2);
        const endRead = await handle.read(
          end,
          0,
          end.length,
          fileSize - end.length
        );
        if (
          endRead.bytesRead === end.length &&
          end[0] === 0xff &&
          end[1] === 0xd9
        ) {
          return "image/jpeg";
        }
      }
      if (
        fileSize >= 12 &&
        bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.readUInt32LE(4) === fileSize - 8 &&
        bytes.toString("ascii", 8, 12) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
      ) {
        return "image/webp";
      }
      return null;
    } finally {
      await handle.close();
    }
  }

  private async removeExpiredTemporaryDirectories(): Promise<void> {
    const now = Date.now();
    const entries = await fs.readdir(this.tempRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(this.tempRoot, entry.name);
      const stat = await fs.stat(directory);
      if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
        await fs.rm(directory, { recursive: true, force: true });
        this.logger.log(
          `Removed expired upload staging directory ${entry.name}`
        );
      }
    }
  }

  private async removeExpiredOrphanedFiles(): Promise<void> {
    const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
    const entries = await fs.readdir(this.finalizedRoot, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(
          entry.name
        )
      ) {
        continue;
      }

      const storageKey = `finalized/${entry.name}`;
      const filePath = this.resolveStorageKey(storageKey);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > cutoff) {
        continue;
      }

      const image = await this.prisma.reportImage.findUnique({
        where: { storageKey },
        select: { id: true },
      });
      if (!image) {
        await fs.rm(filePath, { force: true });
        this.logger.warn(`Removed orphaned report image ${entry.name}`);
      }
    }
  }
}
