---
title: Our work
description: The projects we run and how close each one is to this year's goal.
url: /causes.html
---
<section class="bg-amber-50">
  <div class="mx-auto max-w-4xl px-6 py-20 text-center">
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">Our work</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">What we do, and what it needs</h1>
    <p class="mx-auto mt-5 max-w-2xl text-lg text-stone-700">Each project is run by volunteers and paid for by people like you. Here's how close each one is to this year's goal.</p>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-5xl space-y-6 px-6 py-16">
    {{# each data.causes.items }}
    <article {{# if sample }}data-sample{{/ if }} class="overflow-hidden rounded-2xl ring-1 ring-stone-200 md:grid md:grid-cols-5">
      {{# if image }}<img src="{{ image }}" alt="{{ imageAlt }}" width="1536" height="1024" loading="lazy" class="aspect-[3/2] w-full object-cover md:col-span-2 md:aspect-auto md:h-full">{{/ if }}
      <div class="p-7 sm:p-9 md:col-span-3">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="text-2xl font-bold text-stone-900">{{ title }}</h2>
        <p class="text-sm font-semibold text-brand">{{ percent }}% funded</p>
      </div>
      <p class="mt-3 text-lg text-stone-600">{{ summary }}</p>
      <div class="mt-6 h-3 overflow-hidden rounded-full bg-stone-100"><div class="h-full rounded-full bg-brand" style="width: {{ percent }}%"></div></div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p class="text-stone-600"><span class="font-semibold text-stone-900">{{ raised }}</span> raised of {{ goal }}</p>
        <a href="/donate.html" class="rounded-full bg-stone-900 px-5 py-2 text-sm font-semibold text-white hover:bg-stone-700">Give to this</a>
      </div>
      </div>
    </article>
    {{/ each }}
  </div>
</section>

<section class="bg-stone-900">
  <div class="mx-auto flex max-w-4xl flex-col items-start gap-6 px-6 py-14 sm:flex-row sm:items-center sm:justify-between">
    <h2 class="text-2xl font-bold text-white">Rather give your time?</h2>
    <a href="/volunteer.html" class="rounded-full bg-white px-6 py-3 font-semibold text-stone-900 hover:bg-amber-50">Volunteer with us</a>
  </div>
</section>
