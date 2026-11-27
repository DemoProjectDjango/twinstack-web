---
title: Contact
description: Get in touch to ask for help, volunteer, donate or just say hello.
url: /contact.html
---
<section class="bg-amber-50">
  <div class="mx-auto max-w-4xl px-6 py-20">
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">Contact</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">We'd love to hear from you</h1>
    <p class="mt-5 max-w-2xl text-lg text-stone-700">Whether you need a hand, want to help or have a question, get in touch. Everything you tell us stays private.</p>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto grid max-w-4xl gap-6 px-6 py-16 sm:grid-cols-2">
    {{# if site.contact.email }}
    <a href="mailto:{{ site.contact.email }}" class="rounded-2xl p-7 ring-1 ring-stone-200 hover:ring-brand">
      <p class="text-sm font-semibold text-brand">Email</p>
      <p class="mt-1 break-words text-lg font-semibold text-stone-900">{{ site.contact.email }}</p>
    </a>
    {{/ if }}
    {{# if site.contact.phone }}
    <a href="tel:{{ site.contact.phone }}" class="rounded-2xl p-7 ring-1 ring-stone-200 hover:ring-brand">
      <p class="text-sm font-semibold text-brand">Phone</p>
      <p class="mt-1 text-lg font-semibold text-stone-900">{{ site.contact.phone }}</p>
    </a>
    {{/ if }}
    {{# if site.contact.address }}
    <div class="rounded-2xl p-7 ring-1 ring-stone-200">
      <p class="text-sm font-semibold text-brand">Find us</p>
      <p class="mt-1 text-lg font-semibold text-stone-900">{{ site.contact.address }}</p>
    </div>
    {{/ if }}
    {{# if site.contact.hours }}
    <div class="rounded-2xl p-7 ring-1 ring-stone-200">
      <p class="text-sm font-semibold text-brand">Open</p>
      <p class="mt-1 text-lg font-semibold text-stone-900">{{ site.contact.hours }}</p>
    </div>
    {{/ if }}
  </div>
</section>

<section class="bg-stone-50">
  <div class="mx-auto grid max-w-4xl gap-6 px-6 py-16 sm:grid-cols-2">
    <div class="rounded-2xl bg-white p-7 ring-1 ring-stone-200">
      <h2 class="text-xl font-semibold text-stone-900">Need help?</h2>
      <p class="mt-2 text-stone-600">Call or email us. You don't need a referral, and we won't ask you to explain yourself.</p>
    </div>
    <div class="rounded-2xl bg-white p-7 ring-1 ring-stone-200">
      <h2 class="text-xl font-semibold text-stone-900">Want to help?</h2>
      <p class="mt-2 text-stone-600">See the roles we need, or give to our work.</p>
      <div class="mt-4 flex flex-wrap gap-3">
        <a href="/volunteer.html" class="font-semibold text-brand">Volunteer →</a>
        <a href="/donate.html" class="font-semibold text-brand">Donate →</a>
      </div>
    </div>
  </div>
</section>
