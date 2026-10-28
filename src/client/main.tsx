import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./shell/App.js";
import "./shell/styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("App root element is missing.");
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
