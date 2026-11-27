import { createRoot } from "react-dom/client";
import { App } from "./app";
import { applyTheme } from "./lib/theme";

applyTheme();
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
