import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/auth.css";

const visualReviewOnly = import.meta.env.VITE_REVIEW_MODE === "visual-only";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {visualReviewOnly ? (
      <aside className="visualReviewOnlyNotice" role="status" data-testid="loopops.review.visual-only">
        <strong>视觉审查环境</strong>
        <span>仅用于页面与交互状态检查，不支持创建、导入、连接或执行功能签收。</span>
      </aside>
    ) : null}
    <App />
  </React.StrictMode>,
);
