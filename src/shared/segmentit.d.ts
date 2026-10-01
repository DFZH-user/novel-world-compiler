declare module 'segmentit' {
  export type SegmentToken = { w: string; p: number };
  export class Segment {
    doSegment(text: string, options?: Record<string, unknown>): SegmentToken[];
    loadDict(dict: string | string[]): Segment;
  }
  export function useDefault(segment: Segment): Segment;
  export function cnPOSTag(tag: number): string;
}
