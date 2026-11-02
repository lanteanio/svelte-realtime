<script>
	import { onMount } from 'svelte';

	const catalogs = {
		en: {
			generic: 'Real-time updates are temporarily unavailable.',
			'realtime.unavailable': 'Updates paused for {service}.',
			'realtime.restored': 'Updates restored.'
		},
		de: {
			generic: 'Echtzeit-Updates sind vorübergehend nicht verfügbar.',
			'realtime.unavailable': 'Updates pausiert für {service}.',
			'realtime.restored': 'Updates wiederhergestellt.'
		}
	};
	let locale = 'en';
	let notice = null;
	let noticeText = '';
	let announcementText = '';
	let statusRegion;
	let retryDeadline = null;
	let announcements = [];
	let submissions = 0;

	function translate(value, selectedLocale) {
		if (!value) return '';
		const catalog = catalogs[selectedLocale];
		const template = value.messageKey && Object.hasOwn(catalog, value.messageKey) && typeof catalog[value.messageKey] === 'string'
			? catalog[value.messageKey]
			: null;
		if (template) {
			return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key) =>
				Object.hasOwn(value.messageParams || {}, key) ? String(value.messageParams[key]) : match
			);
		}
		return value.bannerCopy || catalog.generic;
	}

	let unavailable = false;
	$: noticeText = translate(notice, locale);

	onMount(() => {
		const observer = new MutationObserver(() => {
			announcements = [...announcements, statusRegion.textContent];
		});
		observer.observe(statusRegion, { childList: true, characterData: true, subtree: true });
		window.degradationHarness = {
			degraded(mitigation = { messageKey: 'realtime.unavailable', messageParams: { service: 'Redis' }, bannerCopy: 'Updates paused.', retryAfterMs: 60000 }) {
				const transition = !unavailable;
				notice = mitigation;
				unavailable = true;
				// The deadline comes from the event that started the outage; a repeated
				// notice while already degraded must not restart the countdown.
				if ((transition || retryDeadline === null) && Number.isFinite(mitigation.retryAfterMs)) {
					retryDeadline = Date.now() + mitigation.retryAfterMs;
				}
				if (transition) announcementText = translate(notice, locale);
			},
			recovered(recovery = { messageKey: 'realtime.restored', bannerCopy: 'Updates restored.' }) {
				const transition = unavailable;
				notice = recovery;
				unavailable = false;
				retryDeadline = null;
				if (transition) announcementText = translate(notice, locale);
			},
			announcements: () => announcements,
			submissions: () => submissions
		};
		return () => {
			observer.disconnect();
			delete window.degradationHarness;
		};
	});
</script>

<svelte:head><title>Degradation notice fixture</title></svelte:head>

<main>
	<h1>Degradation notices</h1>
	<label for="notice-locale">Notice language</label>
	<select id="notice-locale" bind:value={locale} on:change={() => { document.documentElement.lang = locale; }}>
		<option value="en">English</option>
		<option value="de">Deutsch</option>
	</select>

	<div bind:this={statusRegion} role="status" aria-live="polite" aria-atomic="true" data-testid="notice-status">{announcementText}</div>
	{#if unavailable}
		<p id="degradation-reason">{noticeText}</p>
	{/if}
	<form id="update-form" on:submit|preventDefault={() => { if (!unavailable) submissions += 1; }}>
		<button id="update-action" type="submit" aria-disabled={unavailable} aria-describedby={unavailable ? 'degradation-reason' : undefined}>Submit update</button>
	</form>
	<button id="focus-target">Focus target</button>
	{#if retryDeadline !== null}
		<p id="retry-deadline">Retry at <time datetime={new Date(retryDeadline).toISOString()}>{new Date(retryDeadline).toISOString()}</time></p>
	{/if}
</main>
