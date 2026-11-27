---
title: Donate
description: Give to our work. Every gift goes straight to people in our community who need it.
url: /donate.html
---
<section class="bg-amber-50">
  <div class="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
    <div>
      <p class="text-sm font-semibold uppercase tracking-wider text-brand">Donate</p>
      <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">{{ data.copy.donateTitle }}</h1>
      <p class="mt-5 text-lg text-stone-700">{{ data.copy.donateText }}</p>
      <a href="{{# if data.donate.url }}{{ data.donate.url }}{{ else }}/contact.html{{/ if }}" class="mt-8 inline-block rounded-full bg-brand px-7 py-3.5 text-lg font-semibold text-white shadow-sm hover:opacity-90">{{ data.donate.label }}</a>
      {{# unless data.donate.url }}<p class="mt-3 text-sm text-stone-600">Get in touch and we'll tell you how to give.</p>{{/ unless }}
    </div>
    <div class="rounded-3xl bg-white p-7 shadow-sm ring-1 ring-stone-200">
      <h2 class="text-lg font-semibold text-stone-900">What your gift can do</h2>
      <ul class="mt-5 space-y-4">
        {{# each data.donate.items }}
        <li {{# if sample }}data-sample{{/ if }} class="flex items-start gap-4">
          <span class="w-20 shrink-0 rounded-xl bg-amber-100 py-2 text-center text-lg font-bold text-stone-900">{{ amount }}</span>
          <span class="pt-2 text-stone-700">{{ provides }}</span>
        </li>
        {{/ each }}
      </ul>
    </div>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-6xl px-6 py-20">
    <h2 class="text-3xl font-bold text-stone-900">Other ways to give</h2>
    <div class="mt-10 grid gap-6 md:grid-cols-3">
      <div class="overflow-hidden rounded-2xl bg-stone-50">
        <img data-photo="parcels" src="/assets/img/kit/hearth/parcels.webp" alt="A volunteer helping someone in the community" width="1536" height="1024" loading="lazy" class="aspect-[3/2] w-full object-cover">
        <div class="p-7">
        <h3 class="text-lg font-semibold text-stone-900">Give food</h3>
        <p class="mt-2 text-stone-600">Bring tins, dry food and toiletries to one of our collection days.</p>
        <a href="/events.html" class="mt-4 inline-block font-semibold text-brand">See collection days →</a>
        </div>
      </div>
      <div class="rounded-2xl bg-stone-50 p-7">
        <h3 class="text-lg font-semibold text-stone-900">Fundraise</h3>
        <p class="mt-2 text-stone-600">Run, bake or host something and raise money with friends.</p>
        <a href="/contact.html" class="mt-4 inline-block font-semibold text-brand">Tell us your idea →</a>
      </div>
      <div class="rounded-2xl bg-stone-50 p-7">
        <h3 class="text-lg font-semibold text-stone-900">Give your time</h3>
        <p class="mt-2 text-stone-600">Volunteers are the heart of everything we do.</p>
        <a href="/volunteer.html" class="mt-4 inline-block font-semibold text-brand">Volunteer →</a>
      </div>
    </div>
  </div>
</section>
