// ════════════════════════════════════════════════════════════════════════
// SmartChef — Raw-text recipe draft coercion
// The recipe editors' "Testo grezzo" (raw JSON) mode originally only
// accepted its own exact internal draft shape (ingredients keyed by a real
// library ingredientId, steps as full objects, tools as {id,name,...}).
// A user pasting the same loose recipe JSON the AI import pipeline itself
// produces/accepts — steps as plain sentences, tools as plain names,
// ingredients as {name, quantity, unit, note} — crashed the form instead
// (every .map()/.includes() below assumed the internal shape). These
// coerce either shape into the internal one: an ingredient/tool that isn't
// yet matched to a real library id just comes through with a null id and
// its plain-text name, which the ingredient/tool Autocomplete's "Create
// new" option (see RecipeCreate.tsx/RecipeDetail.tsx) resolves afterward —
// same as an AI-imported recipe would need reviewing anyway.
// ════════════════════════════════════════════════════════════════════════

function newId(): string {
  return crypto.randomUUID();
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function coerceIngredients(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const r = asRecord(item);
    // Already (close to) the internal shape — pass through, just backfill
    // the couple of fields every row needs to render without crashing.
    if (typeof r.ingredientId !== 'undefined' || typeof r.ingredientName === 'string') {
      return { sortOrder: i, isOptional: false, ingredientId: null, ...r };
    }
    return {
      sortOrder: i,
      ingredientId: null,
      ingredientName: typeof r.name === 'string' ? r.name : String(r.name ?? ''),
      quantity: typeof r.quantity === 'number' ? r.quantity : null,
      quantityText: typeof r.quantityText === 'string' ? r.quantityText : undefined,
      unitId: null,
      unitSymbol: typeof r.unit === 'string' ? r.unit : (typeof r.unitSymbol === 'string' ? r.unitSymbol : undefined),
      isOptional: false,
      notes: typeof r.note === 'string' ? r.note : (typeof r.notes === 'string' ? r.notes : null),
      groupName: typeof r.groupName === 'string' ? r.groupName : null,
    };
  });
}

export function coerceSteps(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item === 'string') {
      return {
        id: '', stepNumber: i + 1, title: null, description: item, durationMin: null,
        toolIds: [], techniqueIds: [], notes: null, imageUrl: null, stepIngredients: [], translations: [],
      };
    }
    const r = asRecord(item);
    return {
      id: typeof r.id === 'string' ? r.id : '',
      stepNumber: typeof r.stepNumber === 'number' ? r.stepNumber : i + 1,
      title: typeof r.title === 'string' ? r.title : null,
      description: typeof r.description === 'string' ? r.description : '',
      durationMin: typeof r.durationMin === 'number' ? r.durationMin : null,
      toolIds: Array.isArray(r.toolIds) ? r.toolIds : [],
      techniqueIds: Array.isArray(r.techniqueIds) ? r.techniqueIds : [],
      notes: typeof r.notes === 'string' ? r.notes : null,
      imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : null,
      stepIngredients: Array.isArray(r.stepIngredients) ? r.stepIngredients : [],
      translations: Array.isArray(r.translations) ? r.translations : [],
    };
  });
}

/** Tools and techniques share the same {id, name, icon} shape. */
export function coerceNamedEntities(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') {
      return { id: newId(), name: item, icon: null };
    }
    const r = asRecord(item);
    return { icon: null, ...r, id: typeof r.id === 'string' ? r.id : newId(), name: typeof r.name === 'string' ? r.name : String(r.name ?? '') };
  });
}
