declare module 'unzipper' {
  import type { Readable } from 'node:stream';

  export type OpenEntry = {
    path: string;
    type: 'File' | 'Directory';
    uncompressedSize: number;
    compressedSize: number;
    externalFileAttributes?: number;
    buffer(): Promise<Buffer>;
    stream(): Readable;
  };

  export type OpenDirectory = {
    files: OpenEntry[];
  };

  export const Open: {
    file(filePath: string): Promise<OpenDirectory>;
  };
}
