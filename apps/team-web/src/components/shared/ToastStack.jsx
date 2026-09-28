import { Button } from "./Button.jsx";

export function ToastStack({ toasts, dismissToast, t = (key) => key }) {
  return (
    <div className="toastStack" aria-live="polite" aria-label={t("toast.notifications")}>
      {toasts.slice(0, 2).map((toast) => (
        <div className="toast" key={toast.id} data-testid={`loopops.toast.${toast.id}`}>
          <p>{toast.message}</p>
          <div className="toastActions">
            {toast.actionLabel ? (
              <Button
                variant="plain"
                onClick={() => {
                  toast.action?.();
                  dismissToast(toast.id);
                }}
                data-testid={`loopops.toast.action.${toast.id}`}
              >
                {toast.actionLabel}
              </Button>
            ) : null}
            <Button
              variant="plain"
              onClick={() => dismissToast(toast.id)}
              data-testid={`loopops.toast.close.${toast.id}`}
              aria-label={`${t("actions.close")}: ${toast.message}`}
            >
              {t("actions.close")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
