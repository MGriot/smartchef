import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import RecipeDetail from "./pages/RecipeDetail";
import RecipeCreate from "./pages/RecipeCreate";
import RecipeImport from "./pages/RecipeImport";
import LibraryTools from "./pages/LibraryTools";
import LibraryIngredients from "./pages/LibraryIngredients";
import LibraryUnits from "./pages/LibraryUnits";
import LibraryTechniques from "./pages/LibraryTechniques";
import Planner from "./pages/Planner";
import ShoppingList from "./pages/ShoppingList";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/recipe/new" element={<RecipeCreate />} />
        <Route path="/recipe/:id" element={<RecipeDetail />} />
        <Route path="/import" element={<RecipeImport />} />
        <Route path="/library/tools" element={<LibraryTools />} />
        <Route path="/library/ingredients" element={<LibraryIngredients />} />
        <Route path="/library/units" element={<LibraryUnits />} />
        <Route path="/library/techniques" element={<LibraryTechniques />} />
        <Route path="/planner" element={<Planner />} />
        <Route path="/shopping" element={<ShoppingList />} />
      </Routes>
    </BrowserRouter>
  );
}
