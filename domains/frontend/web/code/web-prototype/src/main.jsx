import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.jsx";
import { workbenchQueryClient } from "./api/queryClient.js";
import "./styles.css";
import "./styles/shell.css";
import "./styles/library.css";
import "./styles/lifecycle.css";
import "./styles/visual-baseline.css";
import "./styles/selected-direction.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={workbenchQueryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
