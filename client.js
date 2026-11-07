// open-in-vscode —— Client 半边：输入框工具栏里的「在 VS Code 中打开」按钮。
//
// 按钮只是触发 Host 的 `/vscode` human 命令（ctx.remote.commands.execute），
// 真正的启动逻辑在 index.mjs：同一条操作，UI 和命令共用一份实现。
window.__ModuleLoader__.load({
  id: '@local/open-in-vscode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'open-in-vscode';

    const zh = {
      'button.tooltip': '在 VS Code 中打开当前工程',
      'button.running': '正在打开 VS Code…',
      'button.failed': '打开失败',
    };
    const en = {
      'button.tooltip': 'Open workspace in VS Code',
      'button.running': 'Opening VS Code…',
      'button.failed': 'Could not open',
    };

    // 与 composer 工具行里其它 28px 圆形图标按钮保持同样的尺寸与主题 token。
    const CSS = [
      '.ovx-open-btn{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;',
      'color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;',
      'place-items:center;display:grid;padding:0}',
      '.ovx-open-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.ovx-open-btn:disabled{opacity:.5;cursor:default}',
      '.ovx-open-btn svg{display:block}',
    ].join('');

    /** 代码括号图标（自绘，无商标素材）。 */
    function Icon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M5.2 3.4 1.9 8l3.3 4.6' }),
        h('path', { d: 'M10.8 3.4 14.1 8l-3.3 4.6' }),
      );
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-vscode: dictionaries');
        const t = ctx.locale.bind(NS);

        function OpenInVscodeButton(props) {
          const sessionId = props.sessionId;
          const [phase, setPhase] = React.useState('idle');
          const [failure, setFailure] = React.useState('');

          React.useEffect(() => {
            if (phase !== 'failed') return undefined;
            const timer = setTimeout(() => {
              setPhase('idle');
              setFailure('');
            }, 4000);
            return () => clearTimeout(timer);
          }, [phase]);

          const run = React.useCallback(async () => {
            if (sessionId === undefined || phase === 'busy') return;
            setPhase('busy');
            setFailure('');
            try {
              const answer = await ctx.remote.commands.execute(sessionId, '/vscode', []);
              if (answer === undefined || answer.ok !== true) {
                const detail = answer !== undefined && answer.ok === false ? (answer.error?.message ?? answer.error?.code ?? '') : '';
                throw new Error(detail || t('button.failed'));
              }
              const result = answer.value?.result;
              if (result !== undefined && result.kind === 'error') {
                setFailure(result.text ?? '');
                setPhase('failed');
                return;
              }
              setPhase('idle');
            } catch (error) {
              setFailure(error instanceof Error ? error.message : String(error));
              setPhase('failed');
            }
          }, [sessionId, phase]);

          const label = phase === 'busy' ? t('button.running') : phase === 'failed' ? (failure || t('button.failed')) : t('button.tooltip');

          return h(
            React.Fragment,
            null,
            h('style', null, CSS),
            h(
              'button',
              {
                type: 'button',
                className: 'ovx-open-btn',
                title: label,
                'aria-label': t('button.tooltip'),
                'aria-busy': phase === 'busy' ? 'true' : undefined,
                disabled: sessionId === undefined || phase === 'busy',
                onClick: () => {
                  run();
                },
              },
              h(Icon),
            ),
          );
        }

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'open-in-vscode',
              order: 20,
              locale: NS,
            },
            OpenInVscodeButton,
          ),
        );
      },
    };
  },
});
