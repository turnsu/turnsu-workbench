import { TurnsuBrand } from "../shared/TurnsuBrand.jsx";
function contentFor(error) {
  if (error?.code === "workbench_unreachable") {
    return {
      eyebrow: "连接暂时中断",
      title: "工作台服务尚未就绪",
      body: "页面已经打开，但暂时无法连接你的工作台。服务启动完成后，可直接在这里重新连接。",
    };
  }

  if (error?.code === "workbench_response_invalid") {
    return {
      eyebrow: "服务尚未准备好",
      title: "暂时无法打开工作台",
      body: "页面已经打开，但当前服务没有返回工作台数据。请确认产品服务已启动后再试一次。",
    };
  }

  return {
    eyebrow: "连接遇到问题",
    title: "暂时无法打开工作台",
    body: "工作台暂时无法响应。请稍候重新连接；尚未提交任何工作内容。",
  };
}

export function WorkspaceConnectionScreen({ error, retrying, onRetry }) {
  const content = contentFor(error);

  return (
    <main className="authPage workspaceConnectionPage">
      <section className="authCard workspaceConnectionCard" aria-labelledby="workspace-connection-title">
        <div className="authBrand"><TurnsuBrand /></div>
        <div className="authHeading">
          <p>{content.eyebrow}</p>
          <h1 id="workspace-connection-title">{content.title}</h1>
          <span>{content.body}</span>
        </div>
        {error?.code ? (
          <details className="workspaceConnectionDetails">
            <summary>查看技术信息</summary>
            <code>{error.code}</code>
          </details>
        ) : null}
        <button
          type="button"
          className="authSubmit"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying}
        >
          {retrying ? "正在重新连接…" : "重新连接"}
        </button>
      </section>
    </main>
  );
}
