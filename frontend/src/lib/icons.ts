import type { IconType } from 'react-icons';
import {
  // produce
  TbCarrot, TbMushroom, TbSalad, TbLeaf, TbSeedling,
  // fruit
  TbApple, TbLemon, TbCherry, TbMelon, TbAvocado,
  // meat & fish
  TbMeat, TbSausage, TbFish,
  // dairy & eggs
  TbEgg, TbEggs, TbEggCracked, TbMilk, TbCheese,
  // grains & pulses
  TbBread, TbGrain, TbWheat, TbBowl,
  // seasoning & fats
  TbPepper, TbSalt, TbDroplet, TbDroplets, TbBottle,
  // sweet
  TbCandy, TbCake, TbCookie, TbIceCream, TbNut,
  // drinks
  TbCoffee, TbMug, TbCup, TbTeapot, TbGlassCocktail, TbBeer,
  // prepared
  TbPizza, TbSoup, TbBowlSpoon, TbBowlChopsticks,
  // heat & cold
  TbFlame, TbGrill, TbGrillFork, TbGrillSpatula, TbCooker, TbSteam,
  TbSnowflake, TbFridge, TbMicrowave, TbThermometer,
  // time
  TbHourglass, TbHourglassHigh, TbHourglassLow, TbClock,
  // equipment
  TbToolsKitchen, TbToolsKitchen2, TbToolsKitchen3, TbChefHat,
  TbBlender, TbScale, TbSlice, TbFilter, TbBrush, TbBox,
  // "free from" — Tabler's systematic Off variants, which is most of why
  // this family was picked: allergen and diet tags finally have an icon
  // that says "without" rather than borrowing the ingredient's own.
  TbMeatOff, TbMilkOff, TbWheatOff, TbEggOff, TbFishOff,
  // misc / fallback
  TbTag, TbTree, TbHandGrab, TbMenu2,
} from 'react-icons/tb';

/**
 * Every icon the app can render, by name.
 *
 * Named imports rather than `import * as Tb` on purpose: the namespace form
 * defeats tree-shaking, and the previous `import * as Fa6` was pulling all
 * 2,058 Font Awesome icons into the main bundle to render the ~40 that are
 * actually reachable.
 */
export const ICON_REGISTRY: Record<string, IconType> = {
  TbCarrot, TbMushroom, TbSalad, TbLeaf, TbSeedling,
  TbApple, TbLemon, TbCherry, TbMelon, TbAvocado,
  TbMeat, TbSausage, TbFish,
  TbEgg, TbEggs, TbEggCracked, TbMilk, TbCheese,
  TbBread, TbGrain, TbWheat, TbBowl,
  TbPepper, TbSalt, TbDroplet, TbDroplets, TbBottle,
  TbCandy, TbCake, TbCookie, TbIceCream, TbNut,
  TbCoffee, TbMug, TbCup, TbTeapot, TbGlassCocktail, TbBeer,
  TbPizza, TbSoup, TbBowlSpoon, TbBowlChopsticks,
  TbFlame, TbGrill, TbGrillFork, TbGrillSpatula, TbCooker, TbSteam,
  TbSnowflake, TbFridge, TbMicrowave, TbThermometer,
  TbHourglass, TbHourglassHigh, TbHourglassLow, TbClock,
  TbToolsKitchen, TbToolsKitchen2, TbToolsKitchen3, TbChefHat,
  TbBlender, TbScale, TbSlice, TbFilter, TbBrush, TbBox,
  TbMeatOff, TbMilkOff, TbWheatOff, TbEggOff, TbFishOff,
  TbTag, TbTree, TbHandGrab, TbMenu2,
};

/**
 * Records saved before the switch carry Font Awesome 6 names. Rather than
 * migrating the database (and every backup file, and every device that
 * hasn't synced yet), those names are translated on the way out — so an
 * ingredient saved as `FaCarrot` keeps drawing a carrot forever.
 *
 * Two of these never rendered as intended in the first place: `FaHamburger`
 * (an FA5 name, renamed FaBurger in FA6) and `FaKnifeKitchen` (Pro-only).
 * Both silently fell back to a tag, which is why the technique picker
 * appeared to contain the tag icon twice and why the saved techniques
 * "Julienne" and "Dice" showed a tag. Mapping them here fixes those records
 * without touching the data.
 */
export const LEGACY_ICON_ALIASES: Record<string, string> = {
  FaEgg: 'TbEgg',
  FaCarrot: 'TbCarrot',
  FaAppleWhole: 'TbApple',
  FaFish: 'TbFish',
  FaBacon: 'TbMeat',
  FaLeaf: 'TbLeaf',
  FaDroplet: 'TbDroplet',
  FaBottleWater: 'TbBottle',
  FaLemon: 'TbLemon',
  FaPepperHot: 'TbPepper',
  FaPizzaSlice: 'TbPizza',
  FaHamburger: 'TbMeat',
  FaIceCream: 'TbIceCream',
  FaWineGlass: 'TbGlassCocktail',
  FaCheese: 'TbCheese',
  FaBreadSlice: 'TbBread',
  FaDrumstickBite: 'TbMeat',
  FaBowlRice: 'TbBowl',
  FaMugHot: 'TbMug',
  FaCookie: 'TbCookie',
  FaTag: 'TbTag',
  FaSeedling: 'TbSeedling',
  FaShrimp: 'TbFish',
  FaWheatAwn: 'TbWheat',
  FaTree: 'TbTree',
  FaUtensils: 'TbToolsKitchen2',
  FaBowlFood: 'TbBowlSpoon',
  FaFire: 'TbFlame',
  FaSnowflake: 'TbSnowflake',
  FaHandFist: 'TbHandGrab',
  FaKnifeKitchen: 'TbToolsKitchen',
  FaClock: 'TbClock',
  FaBlender: 'TbBlender',
  FaMortarPestle: 'TbToolsKitchen3',
  FaFireBurner: 'TbCooker',
  FaKitchenSet: 'TbToolsKitchen',
  FaGripLines: 'TbMenu2',
  FaScaleBalanced: 'TbScale',
  FaBoxOpen: 'TbBox',
  FaFilter: 'TbFilter',
  FaBrush: 'TbBrush',
};

/** The icon for a stored name, translating legacy Font Awesome names, and
 *  falling back to a tag for anything unrecognised. */
export function resolveIcon(name: string | null | undefined): IconType {
  if (!name) return TbTag;
  return ICON_REGISTRY[name] ?? ICON_REGISTRY[LEGACY_ICON_ALIASES[name]] ?? TbTag;
}

/* ── Picker sets ───────────────────────────────────────────────────────
   Grouped by what they mean, in the order they appear in the grid, so the
   pickers read as sections rather than as an arbitrary pile. */

/** Ingredients — also the category picker, which uses the same grid. */
export const INGREDIENT_ICONS = [
  'TbCarrot', 'TbMushroom', 'TbSalad', 'TbLeaf', 'TbSeedling',
  'TbApple', 'TbLemon', 'TbCherry', 'TbMelon', 'TbAvocado',
  'TbMeat', 'TbSausage', 'TbFish',
  'TbEgg', 'TbEggs', 'TbMilk', 'TbCheese',
  'TbBread', 'TbGrain', 'TbWheat', 'TbBowl',
  'TbPepper', 'TbSalt', 'TbDroplet', 'TbBottle',
  'TbCandy', 'TbCake', 'TbCookie', 'TbIceCream', 'TbNut',
  'TbCoffee', 'TbMug', 'TbTeapot', 'TbGlassCocktail', 'TbBeer',
  'TbPizza', 'TbSoup', 'TbTag',
];

/** Tags — course, diet and allergens, the three groups you actually use. */
export const TAG_ICONS = [
  'TbGlassCocktail', 'TbBowlSpoon', 'TbSoup', 'TbMeat', 'TbSalad', 'TbCake', 'TbCup',
  'TbLeaf', 'TbSeedling',
  'TbMeatOff', 'TbMilkOff', 'TbWheatOff', 'TbEggOff', 'TbFishOff',
  'TbMilk', 'TbWheat', 'TbEgg', 'TbFish', 'TbCheese', 'TbNut',
  'TbPepper', 'TbFlame', 'TbSnowflake', 'TbTag',
];

/** Techniques — heat, cold, time and knife work. */
export const TECHNIQUE_ICONS = [
  'TbFlame', 'TbGrill', 'TbGrillFork', 'TbGrillSpatula', 'TbCooker', 'TbSteam',
  'TbSnowflake', 'TbFridge', 'TbMicrowave', 'TbThermometer',
  'TbDroplet', 'TbDroplets', 'TbSoup',
  'TbSlice', 'TbToolsKitchen', 'TbToolsKitchen2', 'TbToolsKitchen3', 'TbBlender',
  'TbHourglass', 'TbHourglassHigh', 'TbHourglassLow', 'TbClock',
  'TbEggCracked', 'TbSalt', 'TbHandGrab', 'TbTag',
];

/** Tools — appliances, vessels and measuring. */
export const TOOL_ICONS = [
  'TbToolsKitchen', 'TbToolsKitchen2', 'TbToolsKitchen3', 'TbChefHat',
  'TbBlender', 'TbCooker', 'TbMicrowave', 'TbFridge', 'TbGrill', 'TbGrillSpatula',
  'TbBowl', 'TbBowlSpoon', 'TbBowlChopsticks', 'TbMug', 'TbCup', 'TbTeapot', 'TbBottle',
  'TbScale', 'TbThermometer', 'TbHourglass', 'TbClock',
  'TbFlame', 'TbSnowflake', 'TbDroplet', 'TbSteam',
  'TbSlice', 'TbFilter', 'TbBrush', 'TbBox', 'TbTag',
];
