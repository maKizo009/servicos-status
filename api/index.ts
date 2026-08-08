import { handleRequest } from "../src/index";

export default async function handler(req: Request): Promise<Response> {
	return handleRequest(req);
}
