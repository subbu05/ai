import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { actions } from "./lib/store";
import { connect } from "./lib/ws";
import "./styles.css";

void actions.bootstrap().then(connect);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
