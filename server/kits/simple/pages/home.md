---
title: Home
url: /
---
<section class="bg-zinc-50">
  <div class="mx-auto max-w-5xl px-6 py-20 sm:py-28">
    <p class="text-sm font-semibold uppercase tracking-wider text-brand">Welcome</p>
    <h1 class="mt-3 text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">{{ site.name }}</h1>
    {{# if site.description }}<p class="mt-5 max-w-2xl text-lg text-zinc-600">{{ site.description }}</p>{{/ if }}
    <div class="mt-8 flex flex-wrap gap-3">
      <a href="/contact.html" class="rounded-lg bg-brand px-5 py-3 font-semibold text-white hover:opacity-90">Get in touch</a>
      {{# if site.contact.phone }}<a href="tel:{{ site.contact.phone }}" class="rounded-lg border border-zinc-300 bg-white px-5 py-3 font-semibold text-zinc-900 hover:bg-zinc-100">Call {{ site.contact.phone }}</a>{{/ if }}
    </div>
  </div>
</section>

<section class="bg-white">
  <div class="mx-auto max-w-5xl px-6 py-16 sm:py-20">
    <h2 class="text-2xl font-bold text-zinc-900 sm:text-3xl">What we offer</h2>
    <div class="mt-8 grid gap-6 sm:grid-cols-3">
      <div data-sample class="rounded-xl border border-zinc-200 p-6">
        <h3 class="font-semibold text-zinc-900">Friendly service</h3>
        <p class="mt-2 text-zinc-600">We take the time to understand what you need and help you get it right.</p>
      </div>
      <div data-sample class="rounded-xl border border-zinc-200 p-6">
        <h3 class="font-semibold text-zinc-900">Quality you can trust</h3>
        <p class="mt-2 text-zinc-600">Careful, reliable work, done properly the first time.</p>
      </div>
      <div data-sample class="rounded-xl border border-zinc-200 p-6">
        <h3 class="font-semibold text-zinc-900">Easy to reach</h3>
        <p class="mt-2 text-zinc-600">Questions? Get in touch and we'll get back to you quickly.</p>
      </div>
    </div>
  </div>
</section>

<section class="bg-brand">
  <div class="mx-auto flex max-w-5xl flex-col items-start gap-6 px-6 py-14 sm:flex-row sm:items-center sm:justify-between">
    <h2 class="text-2xl font-bold text-white">Ready to talk?</h2>
    <a href="/contact.html" class="rounded-lg bg-white px-5 py-3 font-semibold text-zinc-900 hover:bg-zinc-100">Contact us</a>
  </div>
</section>
