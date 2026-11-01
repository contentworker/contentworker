import type { FocalPoint } from '@contentworker/domain';
import type {
  HostedVideo,
  ImageTransformer,
  ImageTransformSpec,
  VideoHost,
  VideoUpload,
} from '@contentworker/ports';

/**
 * An ImageTransformer that records each call and returns a deterministic URL
 * (`<source>#t=<json>`), so tests can assert the transform and focal point the
 * application handed over without depending on any provider's URL grammar.
 */
export class FakeImageTransformer implements ImageTransformer {
  readonly calls: { sourceUrl: string; transform: ImageTransformSpec; focalPoint?: FocalPoint }[] =
    [];

  async transformUrl(sourceUrl: string, transform: ImageTransformSpec, focalPoint?: FocalPoint) {
    this.calls.push({ sourceUrl, transform, ...(focalPoint ? { focalPoint } : {}) });
    return `${sourceUrl}#t=${encodeURIComponent(JSON.stringify({ ...transform, focalPoint }))}`;
  }
}

/**
 * An in-memory VideoHost. Uploads are "received" by the test calling
 * {@link FakeVideoHost.setVideo} — the stand-in for the host finishing an
 * encode — so status transitions are fully under the test's control.
 */
export class FakeVideoHost implements VideoHost {
  readonly provider = 'fake';
  readonly uploads: {
    videoId: string;
    maxDurationSeconds: number;
    meta?: Record<string, string>;
  }[] = [];
  readonly deleted: string[] = [];
  private readonly videos = new Map<string, HostedVideo>();
  private seq = 0;

  async createUpload(opts: {
    maxDurationSeconds: number;
    meta?: Readonly<Record<string, string>>;
  }): Promise<VideoUpload> {
    this.seq += 1;
    const videoId = `vid-${this.seq}`;
    this.uploads.push({
      videoId,
      maxDurationSeconds: opts.maxDurationSeconds,
      ...(opts.meta ? { meta: { ...opts.meta } } : {}),
    });
    this.videos.set(videoId, { videoId, status: 'pending' });
    return {
      videoId,
      uploadUrl: `https://upload.video.local/${videoId}`,
      method: 'POST',
      fileField: 'file',
    };
  }

  async getVideo(videoId: string) {
    return this.videos.get(videoId) ?? null;
  }

  async delete(videoId: string) {
    this.deleted.push(videoId);
    this.videos.delete(videoId);
  }

  /** Sets what the host reports for a video (merged over the current state). */
  setVideo(videoId: string, patch: Partial<HostedVideo>): void {
    const current: HostedVideo = this.videos.get(videoId) ?? { videoId, status: 'pending' };
    this.videos.set(videoId, { ...current, ...patch, videoId });
  }

  /** Simulates the host losing the video (deleted out-of-band). */
  forget(videoId: string): void {
    this.videos.delete(videoId);
  }
}
