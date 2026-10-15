import type { APIRoute } from "astro";
import { handleApi } from "~/lib/api";
import { preflightResponse } from "~/lib/http";
import { requestContext } from "~/lib/twins";

export const prerender = false;

export const GET: APIRoute = ({ params, request, url, clientAddress }) =>
  handleApi(
    params.path ?? "",
    request,
    requestContext(url, request, () => clientAddress),
  );

export const OPTIONS: APIRoute = () => preflightResponse();
