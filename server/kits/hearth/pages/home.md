---
title: Home
url: /
---
<section class="relative overflow-hidden bg-amber-50">
  <div aria-hidden="true" class="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand/15 blur-3xl"></div>
  <div aria-hidden="true" class="absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-orange-200/60 blur-3xl"></div>
  <div class="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 sm:py-28 lg:grid-cols-2">
    <div>
      <p class="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-stone-700 ring-1 ring-stone-200">
        <span class="h-2 w-2 rounded-full bg-brand"></span> {{ data.copy.badge }}
      </p>
      <h1 class="mt-5 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl lg:text-6xl">{{ site.name }}</h1>
      {{# if site.description }}<p class="mt-6 max-w-xl text-lg leading-relaxed text-stone-700">{{ site.description }}</p>{{/ if }}
      <div class="mt-9 flex flex-wrap gap-3">
        <a href="{{# if data.donate.url }}{{ data.donate.url }}{{ else }}/contact.html{{/ if }}" class="rounded-full bg-brand px-6 py-3 font-semibold text-white shadow-sm hover:opacity-90">{{ data.donate.label }}</a>
        <a href="/volunteer.html" class="rounded-full border border-stone-300 bg-white px-6 py-3 font-semibold text-stone-900 hover:bg-stone-100">Volunteer with us</a>
      </div>
    </div>
    <div class="relative">
      <img data-photo="hero" src="/assets/img/kit/hearth/hero.webp" alt="Our volunteers at work" width="1536" height="1024" class="aspect-[4/3] w-full rounded-3xl object-cover shadow-xl">
      <div class="absolute -bottom-6 left-4 right-4 rounded-2xl bg-white p-5 shadow-lg ring-1 ring-stone-200 sm:left-auto sm:right-6 sm:max-w-xs">
        <p class="font-bold text-stone-900">{{ data.copy.heroNote }}</p>
        <p class="mt-1 text-sm text-stone-600">{{ data.copy.heroNoteText }}</p>
      </div>
    </div>
  </div>
</section>

<section class="border-y border-stone-200 bg-white">
  <div class="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-3">
    {{# each data.impact.items }}
    <div {{# if sample }}data-sample{{/ if }} class="text-center sm:text-left">
      <p class="text-4xl font-bold text-brand">{{ value }}</p>
      <p class="mt-1 text-stone-600">{{ label }}</p>
    </div>
    {{/ each }}
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-sm font-semibold uppercase tracking-wider text-brand">Our work</p>
        <h2 class="mt-2 text-3xl font-bold text-stone-900">{{ data.copy.workTitle }}</h2>
      </div>
      <a href="/causes.html" class="font-semibold text-stone-900 underline decoration-brand decoration-2 underline-offset-4">See all our work</a>
    </div>
    <div class="mt-10 grid gap-6 md:grid-cols-3">
      {{# each data.causes.items }}
      <article {{# if sample }}data-sample{{/ if }} class="flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-stone-200">
        {{# if image }}<img src="{{ image }}" alt="{{ imageAlt }}" width="1536" height="1024" loading="lazy" class="aspect-[3/2] w-full object-cover">{{/ if }}
        <div class="flex flex-1 flex-col p-6">
        <h3 class="text-lg font-semibold text-stone-900">{{ title }}</h3>
        <p class="mt-2 flex-1 text-stone-600">{{ summary }}</p>
        <div class="mt-6 h-2.5 overflow-hidden rounded-full bg-stone-100"><div class="h-full rounded-full bg-brand" style="width: {{ percent }}%"></div></div>
        <p class="mt-2 text-sm text-stone-600"><span class="font-semibold text-stone-900">{{ raised }}</span> raised of {{ goal }}</p>
        </div>
      </article>
      {{/ each }}
    </div>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <h2 class="text-center text-3xl font-bold text-stone-900">Three ways to help</h2>
    <div class="mt-10 grid gap-6 md:grid-cols-3">
      <a href="{{# if data.donate.url }}{{ data.donate.url }}{{ else }}/donate.html{{/ if }}" class="group rounded-2xl border border-stone-200 p-7 hover:border-brand">
        <p class="text-sm font-semibold text-brand">01</p>
        <h3 class="mt-2 text-xl font-semibold text-stone-900">Give</h3>
        <p class="mt-2 text-stone-600">Every gift, large or small, goes straight to people who need it.</p>
        <p class="mt-4 font-semibold text-stone-900 group-hover:text-brand">Donate →</p>
      </a>
      <a href="/volunteer.html" class="group rounded-2xl border border-stone-200 p-7 hover:border-brand">
        <p class="text-sm font-semibold text-brand">02</p>
        <h3 class="mt-2 text-xl font-semibold text-stone-900">Volunteer</h3>
        <p class="mt-2 text-stone-600">Pack parcels, drive deliveries or cook. A couple of hours makes a difference.</p>
        <p class="mt-4 font-semibold text-stone-900 group-hover:text-brand">Find a role →</p>
      </a>
      <a href="/events.html" class="group rounded-2xl border border-stone-200 p-7 hover:border-brand">
        <p class="text-sm font-semibold text-brand">03</p>
        <h3 class="mt-2 text-xl font-semibold text-stone-900">Come along</h3>
        <p class="mt-2 text-stone-600">Join a food drive or community evening and bring a friend.</p>
        <p class="mt-4 font-semibold text-stone-900 group-hover:text-brand">See events →</p>
      </a>
    </div>
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <h2 class="text-3xl font-bold text-stone-900">Coming up</h2>
      <a href="/events.html" class="font-semibold text-stone-900 underline decoration-brand decoration-2 underline-offset-4">All events</a>
    </div>
    <div class="mt-8 divide-y divide-stone-200 rounded-2xl bg-white ring-1 ring-stone-200">
      {{# each data.events.items }}
      <div {{# if sample }}data-sample{{/ if }} class="flex items-center gap-5 p-5">
        <div class="w-16 shrink-0 rounded-xl bg-amber-100 py-2 text-center">
          <p class="text-xl font-bold text-stone-900">{{ day }}</p>
          <p class="text-xs font-semibold uppercase text-stone-600">{{ month }}</p>
        </div>
        <div>
          <p class="font-semibold text-stone-900">{{ title }}</p>
          <p class="text-sm text-stone-600">{{ place }} · {{ time }}</p>
        </div>
      </div>
      {{/ each }}
    </div>
  </div>
</section>

<section class="bg-brand">
  <div class="mx-auto flex max-w-6xl flex-col items-start gap-6 px-6 py-16 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h2 class="text-3xl font-bold text-white">{{ data.copy.ctaTitle }}</h2>
      <p class="mt-2 text-white/85">{{ data.copy.ctaText }}</p>
    </div>
    <a href="/donate.html" class="rounded-full bg-white px-6 py-3 font-semibold text-stone-900 hover:bg-amber-50">{{ data.donate.label }}</a>
  </div>
</section>
