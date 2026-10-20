/**
 * qrcode-generator 的类型声明（该包不自带 types）。
 * 只声明本项目用到的 API。
 */
declare module 'qrcode-generator' {
  interface QrCodeOptions {
    cellSize?: number;
    margin?: number;
    scalable?: boolean;
  }
  interface QrCode {
    addData(data: string, mode?: string): void;
    make(): void;
    createSvgTag(options?: QrCodeOptions): string;
    createDataURL(cellSize?: number, margin?: number): string;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
  export default function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QrCode;
}
