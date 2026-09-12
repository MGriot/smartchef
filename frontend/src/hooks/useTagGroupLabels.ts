// ════════════════════════════════════════════════════════════════════════
// SmartChef — Translated tag group headings
//
// Two places render a heading per tag group (Library > Tags and the
// TagPicker chips), and both need the same two-step lookup: the user's own
// translation for the group first, then lib/tagGroups.ts's static fallback
// for the seeded groups. Fetching it in one hook keeps them from drifting
// apart, and keeps the group labels correct in the picker — where they
// were previously translated only if the group happened to be one of the
// four seeded ones.
// ════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';
import { useStore } from '../store/app.store';
import { translateTagGroup, type TagGroupTranslations } from '../lib/tagGroups';

export function useTagGroupLabels() {
  const { t } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);
  const [translations, setTranslations] = useState<TagGroupTranslations>({});

  const reload = useCallback(() => {
    // A server that predates the groups/translations route answers 404, and
    // a group heading is not worth an error banner — fall back to the
    // static lookup and carry on.
    apiFetch('/api/tags/groups/translations')
      .then((res) => (res.ok ? res.json() : { data: {} }))
      .then((json) => setTranslations(json.data ?? {}))
      .catch(() => setTranslations({}));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const label = useCallback(
    (groupName: string) => translateTagGroup(groupName, t, translations, contentLang),
    [t, translations, contentLang],
  );

  return { label, translations, reload };
}
