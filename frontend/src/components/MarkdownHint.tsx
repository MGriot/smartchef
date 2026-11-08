import { useTranslation } from 'react-i18next';

/** One quiet line under a text field: the field renders Markdown, and the
 *  handful of marks it understands (lib/markdown.ts). */
export default function MarkdownHint({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`mt-1 block text-[11px] text-zinc-400 dark:text-zinc-500 ${className}`.trim()}>
      {t('editors.markdownHint')}{' '}
      <code className="font-mono">**{t('editors.markdownBold')}**</code>{' '}
      <code className="font-mono">*{t('editors.markdownItalic')}*</code>{' '}
      <code className="font-mono">- {t('editors.markdownList')}</code>{' '}
      <code className="font-mono">[link](https://…)</code>
    </span>
  );
}
