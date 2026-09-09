import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Autocomplete from './Autocomplete';
import RenderStepText from './RenderStepText';

interface IngredientOption {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
  unitId?: string | null;
  unitSymbol?: string | null;
}

interface ToolOption {
  id: string;
  name: string;
}

interface TechniqueOption {
  id: string;
  name: string;
}

interface UnitOption {
  id: string;
  symbol: string;
}

export type StepIngredientAmount = {
  amountMode: 'fraction' | 'absolute';
  portion?: number;
  quantity?: number;
  unitId?: string;
  unitSymbol?: string;
};

interface StepEditorProps {
  description: string;
  onChangeDescription: (text: string) => void;
  ingredients: IngredientOption[];
  tools: ToolOption[];
  techniques: TechniqueOption[];
  units?: UnitOption[];
  onInsertIngredient?: (sortOrder: number, amount: StepIngredientAmount) => void;
  onInsertTool?: (toolId: string) => void;
}

type Popover = 'ingredient' | 'tool' | 'technique' | null;

/**
 * A step description textarea with a small toolbar to insert inline
 * references — {{ing:N}}, {{tool:id}}, {{tech:id|params}} — at the cursor,
 * plus a live preview showing how they'll render (bold + underlined,
 * Bimby-style) once expanded.
 *
 * `tools` should be the full tool library (not just the recipe's
 * already-selected tools) so a tool can be referenced inline before it's
 * been added to the dedicated Tools section — the caller is responsible for
 * flagging it there once `onInsertTool` fires.
 */
export default function StepEditor({
  description, onChangeDescription, ingredients, tools, techniques, units = [],
  onInsertIngredient, onInsertTool,
}: StepEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [popover, setPopover] = useState<Popover>(null);

  const [pickIngredient, setPickIngredient] = useState('');
  const [pickAmountMode, setPickAmountMode] = useState<'fraction' | 'absolute'>('fraction');
  const [pickPortion, setPickPortion] = useState(1);
  const [pickQuantity, setPickQuantity] = useState<number | null>(null);
  const [pickUnitId, setPickUnitId] = useState<string | null>(null);
  const [pickTool, setPickTool] = useState('');
  const [pickTechnique, setPickTechnique] = useState('');
  const [pickParams, setPickParams] = useState('');

  const insertAtCursor = (token: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? description.length;
    const end = el?.selectionEnd ?? description.length;
    const next = description.slice(0, start) + token + description.slice(end);
    onChangeDescription(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const resetIngredientPicker = () => {
    setPickIngredient('');
    setPickAmountMode('fraction');
    setPickPortion(1);
    setPickQuantity(null);
    setPickUnitId(null);
  };

  const confirmIngredient = () => {
    if (!pickIngredient) return;
    if (pickAmountMode === 'absolute' && !pickQuantity) return;
    insertAtCursor(`{{ing:${pickIngredient}}}`);
    const sortOrder = parseInt(pickIngredient, 10);
    if (pickAmountMode === 'absolute') {
      const unit = units.find(u => u.id === pickUnitId);
      onInsertIngredient?.(sortOrder, {
        amountMode: 'absolute',
        quantity: pickQuantity ?? undefined,
        unitId: pickUnitId ?? undefined,
        unitSymbol: unit?.symbol,
      });
    } else {
      onInsertIngredient?.(sortOrder, { amountMode: 'fraction', portion: pickPortion });
    }
    setPopover(null);
    resetIngredientPicker();
  };

  const confirmTool = () => {
    if (!pickTool) return;
    insertAtCursor(`{{tool:${pickTool}}}`);
    onInsertTool?.(pickTool);
    setPopover(null);
    setPickTool('');
  };

  const confirmTechnique = () => {
    if (!pickTechnique) return;
    insertAtCursor(`{{tech:${pickTechnique}${pickParams ? `|${pickParams}` : ''}}}`);
    setPopover(null);
    setPickTechnique('');
    setPickParams('');
  };

  const previewIngredients = ingredients.map(i => ({
    sortOrder: i.sortOrder,
    name: i.ingredientName,
    quantity: i.quantity ? `${i.quantity}${i.unitSymbol ? ' ' + i.unitSymbol : ''}` : '',
  }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={() => setPopover(popover === 'ingredient' ? null : 'ingredient')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'ingredient' ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}>
          <span className="material-symbols-outlined text-sm">restaurant</span> {t('editors.ingredient')}
        </button>
        <button type="button" onClick={() => setPopover(popover === 'tool' ? null : 'tool')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'tool' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
          <span className="material-symbols-outlined text-sm">construction</span> {t('editors.tool')}
        </button>
        <button type="button" onClick={() => setPopover(popover === 'technique' ? null : 'technique')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'technique' ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
          <span className="material-symbols-outlined text-sm">whatshot</span> {t('editors.technique')}
        </button>
      </div>

      {popover === 'ingredient' && (
        <div className="flex items-end gap-2 mb-2 bg-primary/5 border border-primary/10 rounded-xl p-3 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.ingredient')}</label>
            <Autocomplete
              value={pickIngredient}
              options={ingredients.map(i => ({
                id: String(i.sortOrder),
                label: `${i.ingredientName || t('editors.unnamed')}${i.quantity ? ` — ${i.quantity}${i.unitSymbol ? ' ' + i.unitSymbol : ''}` : ''}`,
              }))}
              onSelect={(id) => {
                setPickIngredient(id);
                const ing = ingredients.find(i => String(i.sortOrder) === id);
                setPickUnitId(ing?.unitId ?? null);
              }}
              onClear={() => { setPickIngredient(''); setPickUnitId(null); }}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
            />
          </div>
          <div>
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.amount')}</label>
            <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 border border-zinc-100 dark:border-zinc-800">
              <button type="button" onClick={() => setPickAmountMode('fraction')}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${pickAmountMode === 'fraction' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500'}`}>
                {t('editors.percentOfTotal')}
              </button>
              <button type="button" onClick={() => setPickAmountMode('absolute')}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${pickAmountMode === 'absolute' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500'}`}>
                {t('editors.exactAmount')}
              </button>
            </div>
          </div>
          {pickAmountMode === 'fraction' ? (
            <div className="w-28">
              <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.portionPercent', { percent: Math.round(pickPortion * 100) })}</label>
              <input type="range" min="0.05" max="1" step="0.05" value={pickPortion} onChange={e => setPickPortion(parseFloat(e.target.value))} className="w-full accent-primary" />
            </div>
          ) : (
            <>
              <div className="w-20">
                <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.qty')}</label>
                <input
                  type="number" step="any" value={pickQuantity ?? ''}
                  onChange={e => setPickQuantity(e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
                />
              </div>
              <div className="w-24">
                <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.unit')}</label>
                <select
                  value={pickUnitId || ''}
                  onChange={e => setPickUnitId(e.target.value || null)}
                  className="w-full px-2 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-xs font-bold"
                >
                  <option value="">{t('editors.unitPlaceholder')}</option>
                  {units.map(u => <option key={u.id} value={u.id}>{u.symbol}</option>)}
                </select>
              </div>
            </>
          )}
          <button type="button" onClick={confirmIngredient} disabled={!pickIngredient || (pickAmountMode === 'absolute' && !pickQuantity)} className="px-3 py-2 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
        </div>
      )}

      {popover === 'tool' && (
        <div className="flex items-end gap-2 mb-2 bg-amber-50 border border-amber-100 rounded-xl p-3">
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.tool')}</label>
            <Autocomplete
              value={pickTool}
              options={tools.map(t => ({ id: t.id, label: t.name }))}
              onSelect={(id) => setPickTool(id)}
              onClear={() => setPickTool('')}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-amber-500/20 text-sm font-bold"
            />
          </div>
          <button type="button" onClick={confirmTool} disabled={!pickTool} className="px-3 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
        </div>
      )}

      {popover === 'technique' && (
        <div className="flex items-end gap-2 mb-2 bg-sky-50 border border-sky-100 rounded-xl p-3">
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.technique')}</label>
            <Autocomplete
              value={pickTechnique}
              options={techniques.map(t => ({ id: t.id, label: t.name }))}
              onSelect={(id) => setPickTechnique(id)}
              onClear={() => setPickTechnique('')}
              placeholder={t('editors.search')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.detailsOptional')}</label>
            <input type="text" value={pickParams} onChange={e => setPickParams(e.target.value)}
              placeholder={t('editors.detailsPlaceholder')}
              className="w-full px-3 py-2 bg-white dark:bg-zinc-900 rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold" />
          </div>
          <button type="button" onClick={confirmTechnique} disabled={!pickTechnique} className="px-3 py-2 bg-sky-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">{t('editors.insert')}</button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={description}
        onChange={e => onChangeDescription(e.target.value)}
        className="w-full border-none bg-white dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px]"
        placeholder={t('editors.describeStep')}
      />

      {description.includes('{{') && (
        <div className="mt-2 px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          <RenderStepText text={description} ingredients={previewIngredients} tools={tools} techniques={techniques} />
        </div>
      )}
    </div>
  );
}
