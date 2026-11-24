interface PhotoSourcingOpts {
  imagePath?: string;
  rows?: string;
  title?: string;
  details?: string;
  priority?: string;
  output?: string;
  write?: boolean;
  headless?: boolean;
}

export async function run(opts: PhotoSourcingOpts): Promise<void> {
  const entry = new URL('../../sourcing/run.mjs', import.meta.url);
  const { runPhotoSourcing } = await import(entry.href);
  await runPhotoSourcing(opts);
}
