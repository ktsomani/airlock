# Airlock release announcement

## LinkedIn

AI is great at generating designs. Your canvas should change only when you say yes.

I’ve released **Pressure** and a **live Paper Desktop adapter** for **Airlock**, an open-source MCP proxy that runs locally.

An agent stages a design change in Airlock. You open the review in Pressure and compare the before and proposed states side by side. The panes scroll together, and you can scrub supported changes. When a change needs a crossfade, Pressure marks it as **Approximated**.

If the proposal looks right, approve the diff in Airlock and click **Admit to canvas**. The live adapter sends the approved call to Paper Desktop with the node ID Paper expects. If Paper rejects a call, Airlock surfaces the reason.

The TypeScript build passes, and all **80 tests across five files** pass, including integration tests.

Try it with Paper Desktop → https://github.com/ktsomani/airlock

## X

AI can generate designs. You decide what lands on your canvas.

Airlock adds a review step between your agent and Paper Desktop. Compare staged changes in Pressure, then approve and admit them in Airlock.

Live Paper adapter. 80 tests passing.

https://github.com/ktsomani/airlock
