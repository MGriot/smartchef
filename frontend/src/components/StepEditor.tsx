import React, { useRef, useState } from 'react';
import Autocomplete from './Autocomplete';
import RenderStepText from './RenderStepText';

interface IngredientOption {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
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

interface StepEditorProps {
  description: string;
  onChangeDescription: (text: string) => void;
  ingredients: IngredientOption[];
  tools: ToolOption[];
  techniques: TechniqueOption[];
  onInsertIngredient?: (sortOrder: number, portion: number) => void;
  onInsertTool?: (toolId: string) => void;
}

type Popover = 'ingredient' | 'tool' | 'technique' | null;

/**
 * A step description textarea with a small toolbar to insert inline
 * references — {{ing:N}}, {{tool:id}}, {{tech:id|params}} — at the cursor,
 * plus a live preview showing how they'll render (bold + underlined,
 * Bimby-style) once expanded.
 */
export default function StepEditor({
  description, onChangeDescription, ingredients, tools, techniques,
  onInsertIngredient, onInsertTool,
}: StepEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [popover, setPopover] = useState<Popover>(null);

  const [pickIngredient, setPickIngredient] = useState('');
  const [pickPortion, setPickPortion] = useState(1);
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

  const confirmIngredient = () => {
    if (!pickIngredient) return;
    insertAtCursor(`{{ing:${pickIngredient}}}`);
    onInsertIngredient?.(parseInt(pickIngredient, 10), pickPortion);
    setPopover(null);
    setPickIngredient('');
    setPickPortion(1);
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
          <span className="material-symbols-outlined text-sm">restaurant</span> Ingredient
        </button>
        <button type="button" onClick={() => setPopover(popover === 'tool' ? null : 'tool')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'tool' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
          <span className="material-symbols-outlined text-sm">construction</span> Tool
        </button>
        <button type="button" onClick={() => setPopover(popover === 'technique' ? null : 'technique')}
          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${popover === 'technique' ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
          <span className="material-symbols-outlined text-sm">whatshot</span> Technique
        </button>
      </div>

      {popover === 'ingredient' && (
        <div className="flex items-end gap-2 mb-2 bg-primary/5 border border-primary/10 rounded-xl p-3">
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 mb-1">Ingredient</label>
            <Autocomplete
              value={pickIngredient}
              options={ingredients.map(i => ({ id: String(i.sortOrder), label: i.ingredientName || 'Unnamed' }))}
              onSelect={(id) => setPickIngredient(id)}
              onClear={() => setPickIngredient('')}
              placeholder="Search…"
              className="w-full px-3 py-2 bg-white rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
            />
          </div>
          <div className="w-28">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 mb-1">Portion {Math.round(pickPortion * 100)}%</label>
            <input type="range" min="0.05" max="1" step="0.05" value={pickPortion} onChange={e => setPickPortion(parseFloat(e.target.value))} className="w-full accent-primary" />
          </div>
          <button type="button" onClick={confirmIngredient} disabled={!pickIngredient} className="px-3 py-2 bg-primary text-white rounded-lg text-xs font-bold disabled:opacity-40">Insert</button>
        </div>
      )}

      {popover === 'tool' && (
        <div className="flex items-end gap-2 mb-2 bg-amber-50 border border-amber-100 rounded-xl p-3">
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 mb-1">Tool</label>
            <Autocomplete
              value={pickTool}
              options={tools.map(t => ({ id: t.id, label: t.name }))}
              onSelect={(id) => setPickTool(id)}
              onClear={() => setPickTool('')}
              placeholder="Search…"
              className="w-full px-3 py-2 bg-white rounded-lg border-none focus:ring-2 focus:ring-amber-500/20 text-sm font-bold"
            />
          </div>
          <button type="button" onClick={confirmTool} disabled={!pickTool} className="px-3 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">Insert</button>
        </div>
      )}

      {popover === 'technique' && (
        <div className="flex items-end gap-2 mb-2 bg-sky-50 border border-sky-100 rounded-xl p-3">
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 mb-1">Technique</label>
            <Autocomplete
              value={pickTechnique}
              options={techniques.map(t => ({ id: t.id, label: t.name }))}
              onSelect={(id) => setPickTechnique(id)}
              onClear={() => setPickTechnique('')}
              placeholder="Search…"
              className="w-full px-3 py-2 bg-white rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[9px] uppercase font-bold text-zinc-400 mb-1">Details (optional)</label>
            <input type="text" value={pickParams} onChange={e => setPickParams(e.target.value)}
              placeholder="e.g. 10 min / 180°C"
              className="w-full px-3 py-2 bg-white rounded-lg border-none focus:ring-2 focus:ring-sky-500/20 text-sm font-bold" />
          </div>
          <button type="button" onClick={confirmTechnique} disabled={!pickTechnique} className="px-3 py-2 bg-sky-500 text-white rounded-lg text-xs font-bold disabled:opacity-40">Insert</button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={description}
        onChange={e => onChangeDescription(e.target.value)}
        className="w-full border-none bg-white rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px]"
        placeholder="Describe this step…"
      />

      {description.includes('{{') && (
        <div className="mt-2 px-4 py-3 bg-zinc-50 rounded-xl text-sm leading-relaxed text-zinc-700">
          <RenderStepText text={description} ingredients={previewIngredients} tools={tools} techniques={techniques} />
        </div>
      )}
    </div>
  );
}
