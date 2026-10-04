import { useCallback, useState, type ReactNode } from 'react';
import ExportFileSheet from '../components/ExportFileSheet';
import { canShareFiles, saveExportFile, type ExportDestination, type ExportFile, type SaveOptions } from '../lib/fileExport';

/** One way for a page to hand a file to the user, whatever it runs on.
 *
 *  `exportFile()` saves straight away where there is a single obvious
 *  destination (Electron's save dialog, the browser's download) and
 *  resolves to where it went, or null on a cancel. On Android it instead
 *  opens ExportFileSheet, where the user picks "save to device" or "share",
 *  and resolves null at once — the sheet reports its own outcome. Errors
 *  from the direct path are thrown to the caller, which already has its
 *  own error handling from the days of the blob download.
 *
 *  The page renders `sheet` somewhere in its tree; it is null unless the
 *  Android sheet is open. */
export function useFileExport(): {
  exportFile: (file: ExportFile, options?: SaveOptions) => Promise<ExportDestination | null>;
  sheet: ReactNode;
} {
  const [pending, setPending] = useState<{ file: ExportFile; options?: SaveOptions } | null>(null);

  const exportFile = useCallback(async (file: ExportFile, options?: SaveOptions) => {
    if (canShareFiles()) {
      setPending({ file, options });
      return null;
    }
    return saveExportFile(file, options);
  }, []);

  const sheet = pending ? (
    <ExportFileSheet file={pending.file} saveOptions={pending.options} onClose={() => setPending(null)} />
  ) : null;

  return { exportFile, sheet };
}
