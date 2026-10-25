import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import { MAX_PASTED_CHARS } from '../lib/recipeMerge';

/** First step of "Merge text with AI": the user pastes what they have about
 *  this dish. The proposals then open in the same review as Check with AI
 *  (RecipeAiReviewDialog), so nothing reaches the draft unticked. */
export default function RecipeMergeTextDialog({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  useEffect(() => { if (open) setText(''); }, [open]);
  const trimmed = text.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('recipeDetail.aiMerge.title')}
      subtitle={t('recipeDetail.aiMerge.subtitle')}
      onSubmit={() => { if (trimmed) onSubmit(trimmed); }}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton disabled={!trimmed}>{t('recipeDetail.aiMerge.submit')}</ModalSubmitButton>
        </>
      }
    >
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value.slice(0, MAX_PASTED_CHARS))}
        placeholder={t('recipeDetail.aiMerge.placeholder')}
        className="w-full min-h-[16rem] rounded-2xl border-none bg-zinc-50 dark:bg-zinc-900 px-4 py-3 text-sm leading-relaxed focus:ring-2 focus:ring-primary/20 resize-y"
      />
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMerge.hint')}</p>
    </Modal>
  );
}
