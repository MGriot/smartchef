import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';

/** Merge-dialog state and POST `${endpoint}/:id/merge` for a catalog whose
 *  merge takes just a target id (tools, techniques). Tags merge free-text
 *  custom tags too, so LibraryTags keeps its own handler. */
export function useCatalogMerge<T extends { id: string }>(endpoint: string, onMerged: () => void) {
  const { t } = useTranslation();
  const [mergeSource, setMergeSource] = useState<T | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [merging, setMerging] = useState(false);

  const startMerge = (item: T) => {
    setMergeSource(item);
    setMergeTargetId('');
  };

  const handleMerge = async () => {
    if (!mergeSource || !mergeTargetId) return;
    setMerging(true);
    try {
      const res = await apiFetch(`${endpoint}/${mergeSource.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: mergeTargetId }),
      });
      const result = await res.json();
      if (res.ok) {
        setMergeSource(null);
        setMergeTargetId('');
        onMerged();
      } else {
        alert(t('library.shared.mergeFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch {
      alert(t('library.shared.networkErrorMerging'));
    } finally {
      setMerging(false);
    }
  };

  return { mergeSource, setMergeSource, mergeTargetId, setMergeTargetId, merging, startMerge, handleMerge };
}
