# Airlock product demo

**Runtime** 2 minutes · **Format** Screen recording with voiceover

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:15 | [Show an agent in VS Code and a Paper page. Highlight the prompt “Add a heading.”] | “You ask an AI agent to add a heading. If it picks the wrong layer and has direct write access, your first chance to catch the mistake comes after the canvas changes.” |
| 0:15–0:30 | [Switch to Airlock, then show the unchanged Paper canvas.] | “Airlock gives you a checkpoint before that write. It’s a local, open-source MCP proxy between your agent and Paper Desktop. The agent stages a proposal. You decide whether it goes through.” |
| 0:30–0:48 | [Ask the agent to stage a heading on an empty test page. Open the pending review in Airlock.] | “Here’s a staged heading. Airlock captures the starting canvas and records the proposed changes. I can inspect the target and the diff while the Paper page stays as it was.” |
| 0:48–1:12 | [Click Open in Pressure on the live review. Cut to a labeled sample with a full snapshot pair. Scroll both panes, drag the scrubber, and highlight an Approximated marker and the cascade panel.] | “Pressure shows both states as live DOM and keeps them in sync as you scroll. With a full snapshot pair, I can scrub supported changes and see the rules behind them. When Pressure can’t interpolate a change, it uses a crossfade and labels it as an approximation.” |
| 1:12–1:35 | [Return to the live review in Airlock. Click Approve diff, then Admit to canvas and confirm. Switch to Paper to show the heading.] | “Back in Airlock, I approve this diff. Admission is a separate step. I click Admit, and Airlock replays the approved call through its live Paper adapter. Now the heading appears in Paper.” |
| 1:35–1:53 | [Show the adapter, then the passing test summary and the Detail Reduced banner.] | “The custom adapter maps Airlock’s snapshot keys to the node IDs Paper expects. All 80 tests pass, including integration tests, and the TypeScript build passes. In this browser run, Pressure measured a 17-millisecond p95 frame interval and switched to crossfades when it exceeded the scrub budget.” |
| 1:53–2:00 | [End card with Airlock, “Try it with Paper Desktop,” and the repository URL.] | “Try Airlock on your next agent-assisted design change. The source and setup guide are on GitHub.” |

Record the live flow on a disposable empty Paper page using `insert-children`. Capture a successful admission before recording the voiceover. Use the Pressure sample or an imported full snapshot pair for the scrub and cascade close-up. Replace `https://github.com/ktsomani/airlock` on the end card.
